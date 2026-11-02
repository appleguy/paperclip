//! Isolated Unix WebSocket framing. The caller authenticates the daemon and
//! admits each outgoing operation; this module is not an ingress fence.
use crate::codex_provider::ExpectedPeer;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc, Arc,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tungstenite::{protocol::WebSocketConfig, Message};

#[cfg(target_os = "macos")]
fn verify_process(peer: &ExpectedPeer, uid: u32) -> Result<(), SharedSocketError> {
    use libproc::libproc::{
        bsd_info::BSDInfo,
        proc_pid::{pidinfo, pidpath},
    };
    let pid = i32::try_from(peer.pid).map_err(|_| SharedSocketError::ConnectFailed)?;
    let before = pidinfo::<BSDInfo>(pid, 0).map_err(|_| SharedSocketError::ConnectFailed)?;
    let path = pidpath(pid).map_err(|_| SharedSocketError::ConnectFailed)?;
    let after = pidinfo::<BSDInfo>(pid, 0).map_err(|_| SharedSocketError::ConnectFailed)?;
    if before.pbi_pid != peer.pid
        || after.pbi_pid != peer.pid
        || before.pbi_uid != uid
        || after.pbi_uid != uid
        || before.pbi_start_tvsec != peer.start_seconds
        || after.pbi_start_tvsec != peer.start_seconds
        || before.pbi_start_tvusec != peer.start_microseconds
        || after.pbi_start_tvusec != peer.start_microseconds
        || Path::new(&path) != peer.executable
    {
        return Err(SharedSocketError::ConnectFailed);
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn verify_process(_: &ExpectedPeer, _: u32) -> Result<(), SharedSocketError> {
    Err(SharedSocketError::ConnectFailed)
}

#[cfg(target_os = "macos")]
fn authenticate_stream(
    stream: UnixStream,
    peer: &ExpectedPeer,
) -> Result<UnixStream, SharedSocketError> {
    // The socket can be opened by a synchronous caller inside an existing
    // Tokio runtime. Own and drop this temporary reactor on a separate thread.
    std::thread::scope(|scope| {
        scope
            .spawn(move || authenticate_stream_on_thread(stream, peer))
            .join()
            .map_err(|_| SharedSocketError::ConnectFailed)?
    })
}

#[cfg(target_os = "macos")]
fn authenticate_stream_on_thread(
    stream: UnixStream,
    peer: &ExpectedPeer,
) -> Result<UnixStream, SharedSocketError> {
    stream
        .set_nonblocking(true)
        .map_err(|_| SharedSocketError::ConnectFailed)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .build()
        .map_err(|_| SharedSocketError::ConnectFailed)?;
    let guard = runtime.enter();
    let stream =
        tokio::net::UnixStream::from_std(stream).map_err(|_| SharedSocketError::ConnectFailed)?;
    let cred = stream
        .peer_cred()
        .map_err(|_| SharedSocketError::ConnectFailed)?;
    let uid = rustix::process::geteuid().as_raw();
    if cred.pid() != Some(peer.pid as i32) || cred.uid() != uid {
        return Err(SharedSocketError::ConnectFailed);
    }
    verify_process(peer, uid)?;
    let stream = stream
        .into_std()
        .map_err(|_| SharedSocketError::ConnectFailed)?;
    drop(guard);
    stream
        .set_nonblocking(false)
        .map_err(|_| SharedSocketError::ConnectFailed)?;
    Ok(stream)
}

#[cfg(not(target_os = "macos"))]
fn authenticate_stream(_: UnixStream, _: &ExpectedPeer) -> Result<UnixStream, SharedSocketError> {
    Err(SharedSocketError::ConnectFailed)
}

const MAX_FRAME: usize = 1024 * 1024;
const EVENT_CAPACITY: usize = 128;
const EVENT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum SharedSocketError {
    InvalidInput,
    ConnectFailed,
    OutcomeUnknown,
    Closed,
    Protocol,
}

/// Inspect the kernel-authenticated peer of an already listening local socket.
/// This does not authorize its use or send any provider protocol messages.
#[cfg(target_os = "macos")]
pub fn inspect_peer(path: &Path) -> Result<(ExpectedPeer, String), SharedSocketError> {
    use libproc::libproc::{
        bsd_info::BSDInfo,
        proc_pid::{pidinfo, pidpath},
    };
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    if !path.is_absolute() {
        return Err(SharedSocketError::InvalidInput);
    }
    let before = std::fs::symlink_metadata(path).map_err(|_| SharedSocketError::ConnectFailed)?;
    let uid = rustix::process::geteuid().as_raw();
    if !before.file_type().is_socket() || before.uid() != uid || before.mode() & 0o022 != 0 {
        return Err(SharedSocketError::ConnectFailed);
    }
    let generation = format!(
        "{}:{}:{}:{}",
        before.dev(),
        before.ino(),
        before.ctime(),
        before.ctime_nsec()
    );
    let stream = UnixStream::connect(path).map_err(|_| SharedSocketError::ConnectFailed)?;
    stream
        .set_nonblocking(true)
        .map_err(|_| SharedSocketError::ConnectFailed)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .build()
        .map_err(|_| SharedSocketError::ConnectFailed)?;
    let guard = runtime.enter();
    let stream =
        tokio::net::UnixStream::from_std(stream).map_err(|_| SharedSocketError::ConnectFailed)?;
    let credentials = stream
        .peer_cred()
        .map_err(|_| SharedSocketError::ConnectFailed)?;
    let pid = credentials
        .pid()
        .filter(|pid| *pid > 0)
        .ok_or(SharedSocketError::ConnectFailed)?;
    if credentials.uid() != uid {
        return Err(SharedSocketError::ConnectFailed);
    }
    let first = pidinfo::<BSDInfo>(pid, 0).map_err(|_| SharedSocketError::ConnectFailed)?;
    let executable = pidpath(pid).map_err(|_| SharedSocketError::ConnectFailed)?;
    let last = pidinfo::<BSDInfo>(pid, 0).map_err(|_| SharedSocketError::ConnectFailed)?;
    let after = std::fs::symlink_metadata(path).map_err(|_| SharedSocketError::ConnectFailed)?;
    if first.pbi_pid != pid as u32
        || last.pbi_pid != pid as u32
        || first.pbi_uid != uid
        || last.pbi_uid != uid
        || first.pbi_start_tvsec != last.pbi_start_tvsec
        || first.pbi_start_tvusec != last.pbi_start_tvusec
        || before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err(SharedSocketError::ConnectFailed);
    }
    drop(stream);
    drop(guard);
    drop(runtime);
    Ok((
        ExpectedPeer {
            pid: pid as u32,
            start_seconds: first.pbi_start_tvsec,
            start_microseconds: first.pbi_start_tvusec,
            executable: executable.into(),
        },
        generation,
    ))
}

/// This callback is invoked only for an exact-thread approval request. Returning
/// None leaves it unanswered. The caller must check turn and operation authority.
pub type ApprovalAdmission = Arc<dyn Fn(&Value) -> Option<Value> + Send + Sync + 'static>;

enum Command {
    Request {
        frame: String,
        id: u64,
        reply: mpsc::SyncSender<Result<Value, SharedSocketError>>,
    },
    Initialized {
        reply: mpsc::SyncSender<Result<(), SharedSocketError>>,
    },
    ToolResponse {
        call_id: String,
        result: Value,
        reply: mpsc::SyncSender<Result<(), SharedSocketError>>,
    },
    Detach,
}
struct Pending {
    id: u64,
    deadline: Instant,
    reply: mpsc::SyncSender<Result<Value, SharedSocketError>>,
}

pub struct SharedSocket {
    commands: mpsc::SyncSender<Command>,
    events: mpsc::Receiver<(Value, usize)>,
    event_bytes: Arc<AtomicUsize>,
    wake: UnixStream,
    worker: Option<JoinHandle<()>>,
    timeout: Duration,
    next_id: u64,
    failed: bool,
    peer: Option<ExpectedPeer>,
    bootstrap_thread: Option<Arc<std::sync::Mutex<Option<String>>>>,
    #[cfg(test)]
    wake_count: Arc<AtomicUsize>,
}
impl SharedSocket {
    /// The caller must verify socket/daemon identity before attaching. The
    /// optional approval callback must not block and may decline any request.
    pub fn connect(
        path: &Path,
        timeout: Duration,
        thread_id: String,
        admission: Option<ApprovalAdmission>,
    ) -> Result<Self, SharedSocketError> {
        Self::connect_with_limits(
            path,
            timeout,
            thread_id,
            admission,
            EVENT_CAPACITY,
            EVENT_BYTES,
            None,
            false,
            false,
        )
    }

    pub fn connect_authenticated(
        path: &Path,
        timeout: Duration,
        thread_id: String,
        peer: ExpectedPeer,
    ) -> Result<Self, SharedSocketError> {
        Self::connect_with_limits(
            path,
            timeout,
            thread_id,
            None,
            EVENT_CAPACITY,
            EVENT_BYTES,
            Some(peer),
            false,
            false,
        )
    }

    /// Opt-in exact-thread tool requests; authority and durable receipts remain
    /// with the caller, and no request is answered merely by receiving it.
    pub fn connect_authenticated_with_tools(
        path: &Path,
        timeout: Duration,
        thread_id: String,
        peer: ExpectedPeer,
    ) -> Result<Self, SharedSocketError> {
        Self::connect_with_limits(
            path,
            timeout,
            thread_id,
            None,
            EVENT_CAPACITY,
            EVENT_BYTES,
            Some(peer),
            true,
            false,
        )
    }

    /// Buffers bounded events until thread/start returns its native identity.
    pub fn connect_bootstrap_authenticated_with_tools(
        path: &Path,
        timeout: Duration,
        peer: ExpectedPeer,
    ) -> Result<Self, SharedSocketError> {
        Self::connect_with_limits(
            path,
            timeout,
            String::new(),
            None,
            EVENT_CAPACITY,
            EVENT_BYTES,
            Some(peer),
            true,
            true,
        )
    }

    fn connect_with_limits(
        path: &Path,
        timeout: Duration,
        thread_id: String,
        admission: Option<ApprovalAdmission>,
        event_capacity: usize,
        event_limit: usize,
        peer: Option<ExpectedPeer>,
        allow_tools: bool,
        bootstrap: bool,
    ) -> Result<Self, SharedSocketError> {
        if !path.is_absolute()
            || timeout.is_zero()
            || (thread_id.is_empty() && !bootstrap)
            || thread_id.len() > 240
            || thread_id.chars().any(char::is_control)
            || event_capacity == 0
            || event_limit == 0
        {
            return Err(SharedSocketError::InvalidInput);
        }
        let bootstrap_thread = bootstrap.then(|| Arc::new(std::sync::Mutex::new(None::<String>)));
        let worker_bootstrap_thread = bootstrap_thread.clone();
        let stream = UnixStream::connect(path).map_err(|_| SharedSocketError::ConnectFailed)?;
        let stream = match peer.as_ref() {
            Some(peer) => authenticate_stream(stream, peer)?,
            None => stream,
        };
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|_| SharedSocketError::ConnectFailed)?;
        stream
            .set_write_timeout(Some(timeout))
            .map_err(|_| SharedSocketError::ConnectFailed)?;
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_FRAME))
            .max_frame_size(Some(MAX_FRAME));
        let (socket, _) =
            tungstenite::client::client_with_config("ws://localhost/", stream, Some(config))
                .map_err(|_| SharedSocketError::ConnectFailed)?;
        socket
            .get_ref()
            .set_nonblocking(true)
            .map_err(|_| SharedSocketError::ConnectFailed)?;
        let (wake, mut wake_reader) =
            UnixStream::pair().map_err(|_| SharedSocketError::ConnectFailed)?;
        wake.set_nonblocking(true)
            .map_err(|_| SharedSocketError::ConnectFailed)?;
        wake_reader
            .set_nonblocking(true)
            .map_err(|_| SharedSocketError::ConnectFailed)?;
        let (commands, rx) = mpsc::sync_channel(1);
        let (event_tx, events) = mpsc::sync_channel(event_capacity);
        let event_bytes = Arc::new(AtomicUsize::new(0));
        let queued_bytes = event_bytes.clone();
        #[cfg(test)]
        let wake_count = Arc::new(AtomicUsize::new(0));
        #[cfg(test)]
        let worker_wake_count = wake_count.clone();
        let worker = thread::spawn(move || {
            let mut socket = socket;
            let mut pending: Option<Pending> = None;
            let mut tool_requests = std::collections::HashMap::<String, (Value, String)>::new();
            loop {
                match rx.try_recv() {
                    Ok(Command::Detach) | Err(mpsc::TryRecvError::Disconnected) => break,
                    Ok(Command::Request { frame, id, reply }) => {
                        if pending.is_some() {
                            let _ = reply.send(Err(SharedSocketError::Closed));
                            break;
                        }
                        if socket.send(Message::Text(frame.into())).is_err() {
                            let _ = reply.send(Err(SharedSocketError::OutcomeUnknown));
                            break;
                        }
                        pending = Some(Pending {
                            id,
                            deadline: Instant::now() + timeout,
                            reply,
                        });
                    }
                    Ok(Command::Initialized { reply }) => {
                        let result = socket
                            .send(Message::Text(
                                json!({"method":"initialized"}).to_string().into(),
                            ))
                            .map_err(|_| SharedSocketError::OutcomeUnknown);
                        let failed = result.is_err();
                        let _ = reply.send(result);
                        if failed {
                            break;
                        }
                    }
                    Ok(Command::ToolResponse {
                        call_id,
                        result,
                        reply,
                    }) => {
                        let sent =
                            if let Some((id, request_thread)) = tool_requests.remove(&call_id) {
                                let allowed = worker_bootstrap_thread
                                    .as_ref()
                                    .map(|value| {
                                        value.lock().ok().and_then(|v| v.clone()).as_deref()
                                            == Some(request_thread.as_str())
                                    })
                                    .unwrap_or(request_thread == thread_id);
                                let frame = json!({"id":id,"result":result}).to_string();
                                if !allowed || frame.len() > MAX_FRAME {
                                    Err(SharedSocketError::InvalidInput)
                                } else {
                                    socket
                                        .send(Message::Text(frame.into()))
                                        .map_err(|_| SharedSocketError::OutcomeUnknown)
                                }
                            } else {
                                Err(SharedSocketError::InvalidInput)
                            };
                        let failed = matches!(sent, Err(SharedSocketError::OutcomeUnknown));
                        let _ = reply.send(sent);
                        if failed {
                            break;
                        }
                    }
                    Err(mpsc::TryRecvError::Empty) => {}
                }
                if pending
                    .as_ref()
                    .is_some_and(|p| Instant::now() >= p.deadline)
                {
                    break;
                }
                let text = match socket.read() {
                    Ok(Message::Text(text)) => text,
                    Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => continue,
                    Err(tungstenite::Error::Io(e))
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) =>
                    {
                        use rustix::event::{poll, PollFd, PollFlags, Timespec};
                        let remaining = pending
                            .as_ref()
                            .map(|p| p.deadline.saturating_duration_since(Instant::now()));
                        let deadline = remaining.map(|duration| Timespec {
                            tv_sec: duration.as_secs().min(i64::MAX as u64) as _,
                            tv_nsec: duration.subsec_nanos() as _,
                        });
                        let (socket_ready, wake_ready) = {
                            let mut fds = [
                                PollFd::new(socket.get_ref(), PollFlags::IN),
                                PollFd::new(&wake_reader, PollFlags::IN),
                            ];
                            match poll(&mut fds, deadline.as_ref()) {
                                Ok(_) => {
                                    (!fds[0].revents().is_empty(), !fds[1].revents().is_empty())
                                }
                                Err(rustix::io::Errno::INTR) => continue,
                                Err(_) => break,
                            }
                        };
                        #[cfg(test)]
                        worker_wake_count.fetch_add(1, Ordering::Relaxed);
                        if wake_ready {
                            let mut buf = [0u8; 32];
                            let _ = wake_reader.read(&mut buf);
                        }
                        if !socket_ready && !wake_ready && pending.is_none() {
                            break;
                        }
                        continue;
                    }
                    _ => break,
                };
                let value: Value = match serde_json::from_str::<Value>(&text) {
                    Ok(v) if v.is_object() => v,
                    _ => break,
                };
                if let Some(method) = value.get("method").and_then(Value::as_str) {
                    let incoming_thread = value.pointer("/params/threadId").and_then(Value::as_str);
                    let exact_thread = if let Some(binding) = worker_bootstrap_thread.as_ref() {
                        match binding.lock().ok().and_then(|v| v.clone()) {
                            Some(bound) => incoming_thread == Some(bound.as_str()),
                            None => incoming_thread.is_some(),
                        }
                    } else {
                        incoming_thread == Some(thread_id.as_str())
                    };
                    if let Some(id) = value.get("id") {
                        if allow_tools && exact_thread && method == "item/tool/call" {
                            let call = value
                                .pointer("/params/callId")
                                .and_then(Value::as_str)
                                .filter(|s| !s.is_empty() && s.len() <= 240);
                            let turn = value
                                .pointer("/params/turnId")
                                .and_then(Value::as_str)
                                .filter(|s| !s.is_empty() && s.len() <= 240);
                            if let (Some(call), Some(_)) = (call, turn) {
                                if tool_requests.len() >= event_capacity
                                    || tool_requests.contains_key(call)
                                {
                                    break;
                                }
                                let size = text.len();
                                if queued_bytes
                                    .try_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                                        used.checked_add(size).filter(|next| *next <= event_limit)
                                    })
                                    .is_err()
                                {
                                    break;
                                }
                                tool_requests.insert(
                                    call.to_owned(),
                                    (id.clone(), incoming_thread.unwrap_or_default().to_owned()),
                                );
                                if event_tx.try_send((value, size)).is_err() {
                                    queued_bytes.fetch_sub(size, Ordering::AcqRel);
                                    break;
                                }
                            }
                            continue;
                        }
                        // Unknown/foreign requests never receive even a rejection.
                        let approval = matches!(
                            method,
                            "item/commandExecution/requestApproval"
                                | "item/fileChange/requestApproval"
                                | "item/permissions/requestApproval"
                        );
                        if exact_thread && approval {
                            if let Some(result) = admission.as_ref().and_then(|f| f(&value)) {
                                let response = json!({"id": id, "result": result}).to_string();
                                if response.len() > MAX_FRAME
                                    || socket.send(Message::Text(response.into())).is_err()
                                {
                                    break;
                                }
                            }
                        }
                    } else if exact_thread {
                        let size = text.len();
                        let reserved =
                            queued_bytes.try_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                                used.checked_add(size).filter(|next| *next <= event_limit)
                            });
                        if reserved.is_err() {
                            break;
                        }
                        if event_tx.try_send((value, size)).is_err() {
                            queued_bytes.fetch_sub(size, Ordering::AcqRel);
                            break;
                        }
                    }
                    continue;
                }
                if let Some(p) = pending.as_ref() {
                    if value.get("id").and_then(Value::as_u64) == Some(p.id) {
                        if value.get("result").is_some() == value.get("error").is_some() {
                            break;
                        }
                        let p = pending.take().expect("pending request exists");
                        let _ = p.reply.send(Ok(value));
                    }
                }
            }
            if let Some(p) = pending {
                let _ = p.reply.send(Err(SharedSocketError::OutcomeUnknown));
            }
        });
        Ok(Self {
            commands,
            events,
            event_bytes,
            wake,
            worker: Some(worker),
            timeout,
            next_id: 1,
            failed: false,
            peer,
            bootstrap_thread,
            #[cfg(test)]
            wake_count,
        })
    }
    pub fn request(&mut self, method: &str, params: Value) -> Result<Value, SharedSocketError> {
        if self.failed {
            return Err(SharedSocketError::Closed);
        }
        if method.is_empty() || method.len() > 256 || !params.is_object() {
            return Err(SharedSocketError::InvalidInput);
        }
        let id = self.next_id;
        self.next_id = id.checked_add(1).ok_or(SharedSocketError::Closed)?;
        let frame = json!({"id": id, "method": method, "params": params}).to_string();
        if frame.len() > MAX_FRAME {
            return Err(SharedSocketError::InvalidInput);
        }
        let (tx, rx) = mpsc::sync_channel(1);
        if self
            .commands
            .send(Command::Request {
                frame,
                id,
                reply: tx,
            })
            .is_err()
        {
            self.failed = true;
            return Err(SharedSocketError::Closed);
        }
        if self.wake.write_all(&[1]).is_err() {
            self.failed = true;
            return Err(SharedSocketError::OutcomeUnknown);
        }
        match rx.recv_timeout(self.timeout + Duration::from_secs(1)) {
            Ok(Ok(value)) => Ok(value),
            _ => {
                self.failed = true;
                let _ = self.commands.try_send(Command::Detach);
                let _ = self.wake.write_all(&[1]);
                Err(SharedSocketError::OutcomeUnknown)
            }
        }
    }
    pub fn initialized(&mut self) -> Result<(), SharedSocketError> {
        if self.failed {
            return Err(SharedSocketError::Closed);
        }
        let (tx, rx) = mpsc::sync_channel(1);
        if self
            .commands
            .send(Command::Initialized { reply: tx })
            .is_err()
        {
            self.failed = true;
            return Err(SharedSocketError::Closed);
        }
        if self.wake.write_all(&[1]).is_err() {
            self.failed = true;
            return Err(SharedSocketError::OutcomeUnknown);
        }
        match rx.recv_timeout(self.timeout + Duration::from_secs(1)) {
            Ok(Ok(())) => Ok(()),
            _ => {
                self.failed = true;
                let _ = self.commands.try_send(Command::Detach);
                let _ = self.wake.write_all(&[1]);
                Err(SharedSocketError::OutcomeUnknown)
            }
        }
    }
    /// Send an already-durable semantic receipt to the matching native RPC.
    pub fn respond_tool(&mut self, call_id: &str, result: Value) -> Result<(), SharedSocketError> {
        if self.failed {
            return Err(SharedSocketError::Closed);
        }
        if call_id.is_empty()
            || call_id.len() > 240
            || !result.is_object()
            || result.to_string().len() > MAX_FRAME
        {
            return Err(SharedSocketError::InvalidInput);
        }
        let (tx, rx) = mpsc::sync_channel(1);
        self.commands
            .send(Command::ToolResponse {
                call_id: call_id.to_owned(),
                result,
                reply: tx,
            })
            .map_err(|_| SharedSocketError::Closed)?;
        if self.wake.write_all(&[1]).is_err() {
            self.failed = true;
            return Err(SharedSocketError::OutcomeUnknown);
        }
        match rx.recv_timeout(self.timeout + Duration::from_secs(1)) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(SharedSocketError::InvalidInput)) => Err(SharedSocketError::InvalidInput),
            _ => {
                self.failed = true;
                let _ = self.commands.try_send(Command::Detach);
                let _ = self.wake.write_all(&[1]);
                Err(SharedSocketError::OutcomeUnknown)
            }
        }
    }
    pub fn receive_notification(
        &self,
        timeout: Duration,
    ) -> Result<Option<Value>, SharedSocketError> {
        let bound = if let Some(value) = &self.bootstrap_thread {
            Some(
                value
                    .lock()
                    .map_err(|_| SharedSocketError::Closed)?
                    .clone()
                    .ok_or(SharedSocketError::InvalidInput)?,
            )
        } else {
            None
        };
        let deadline = Instant::now() + timeout;
        loop {
            match self
                .events
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            {
                Ok((v, size)) => {
                    self.event_bytes.fetch_sub(size, Ordering::AcqRel);
                    // Daemon-originated MCP startup progress is neither provider work nor
                    // owner input; a configured owner daemon emits it for every new thread.
                    if v.get("id").is_none()
                        && v.get("method").and_then(Value::as_str)
                            == Some("mcpServer/startupStatus/updated")
                    {
                        continue;
                    }
                    if bound.as_ref().is_none_or(|thread| {
                        v.pointer("/params/threadId").and_then(Value::as_str)
                            == Some(thread.as_str())
                    }) {
                        return Ok(Some(v));
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => return Ok(None),
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(SharedSocketError::Closed),
            }
        }
    }
    /// Bind exactly once after the authenticated thread/start response.
    pub fn bind_bootstrap_thread(&mut self, thread_id: &str) -> Result<(), SharedSocketError> {
        if thread_id.is_empty() || thread_id.len() > 240 || thread_id.chars().any(char::is_control)
        {
            return Err(SharedSocketError::InvalidInput);
        }
        let state = self
            .bootstrap_thread
            .as_ref()
            .ok_or(SharedSocketError::InvalidInput)?;
        let mut bound = state.lock().map_err(|_| SharedSocketError::Closed)?;
        if bound.is_some() {
            return Err(SharedSocketError::InvalidInput);
        }
        *bound = Some(thread_id.to_owned());
        Ok(())
    }
    pub fn verify_peer(&self) -> Result<(), SharedSocketError> {
        let peer = self.peer.as_ref().ok_or(SharedSocketError::ConnectFailed)?;
        verify_process(peer, rustix::process::geteuid().as_raw())
    }
    pub fn detach(self) {
        drop(self);
    }
}
impl Drop for SharedSocket {
    fn drop(&mut self) {
        let _ = self.commands.try_send(Command::Detach);
        let _ = self.wake.write_all(&[1]);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static NEXT_SOCKET: AtomicUsize = AtomicUsize::new(0);
    fn listener() -> (std::path::PathBuf, UnixListener) {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = format!(
            "/Volumes/NVM/AI_Agent_Runtime/tmp/ws-{}-{nonce:x}-{}",
            std::process::id(),
            NEXT_SOCKET.fetch_add(1, Ordering::Relaxed)
        )
        .into();
        let l = UnixListener::bind(&path).unwrap();
        (path, l)
    }
    fn send(ws: &mut tungstenite::WebSocket<UnixStream>, v: Value) {
        ws.send(Message::Text(v.to_string().into())).unwrap();
    }
    #[test]
    fn tool_requests_are_exact_thread_and_receipt_correlated() {
        let (path, l) = listener();
        let server = thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut ws = tungstenite::accept(s).unwrap();
            send(
                &mut ws,
                json!({"id":1,"method":"item/tool/call","params":{"threadId":"foreign","turnId":"turn","callId":"foreign","tool":"tool","arguments":{}}}),
            );
            send(
                &mut ws,
                json!({"id":2,"method":"item/tool/call","params":{"threadId":"t","turnId":"turn","callId":"call","tool":"tool","arguments":{}}}),
            );
            let result: Value =
                serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(result["id"], 2);
            assert_eq!(result["result"]["success"], true);
        });
        let mut socket = SharedSocket::connect_with_limits(
            &path,
            Duration::from_secs(2),
            "t".into(),
            None,
            8,
            EVENT_BYTES,
            None,
            true,
            false,
        )
        .unwrap();
        let request = socket
            .receive_notification(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        assert_eq!(request["params"]["callId"], "call");
        assert!(matches!(
            socket.respond_tool("foreign", json!({"success":true,"contentItems":[]})),
            Err(SharedSocketError::InvalidInput)
        ));
        socket
            .respond_tool("call", json!({"success":true,"contentItems":[]}))
            .unwrap();
        assert!(socket
            .respond_tool("call", json!({"success":true,"contentItems":[]}))
            .is_err());
        server.join().unwrap();
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn bootstrap_buffers_only_exact_thread_through_binding() {
        let (path, l) = listener();
        let server = thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut ws = tungstenite::accept(s).unwrap();
            send(
                &mut ws,
                json!({"id":1,"method":"item/tool/call","params":{"threadId":"foreign","turnId":"turn","callId":"foreign","tool":"tool","arguments":{}}}),
            );
            send(
                &mut ws,
                json!({"id":2,"method":"item/tool/call","params":{"threadId":"owned","turnId":"turn","callId":"call","tool":"tool","arguments":{}}}),
            );
            let result: Value =
                serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(result["id"], 2);
        });
        let mut socket = SharedSocket::connect_with_limits(
            &path,
            Duration::from_secs(2),
            String::new(),
            None,
            8,
            EVENT_BYTES,
            None,
            true,
            true,
        )
        .unwrap();
        thread::sleep(Duration::from_millis(50));
        socket.bind_bootstrap_thread("owned").unwrap();
        assert!(socket.bind_bootstrap_thread("foreign").is_err());
        let request = socket
            .receive_notification(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        assert_eq!(request["params"]["callId"], "call");
        assert!(socket
            .respond_tool("foreign", json!({"success":true,"contentItems":[]}))
            .is_err());
        socket
            .respond_tool("call", json!({"success":true,"contentItems":[]}))
            .unwrap();
        server.join().unwrap();
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn mcp_startup_status_is_not_an_observed_notification() {
        let (path, l) = listener();
        let server = thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut ws = tungstenite::accept(s).unwrap();
            send(
                &mut ws,
                json!({"method":"mcpServer/startupStatus/updated","params":{"threadId":"owned","name":"x","status":"starting"}}),
            );
            send(
                &mut ws,
                json!({"method":"thread/status/changed","params":{"threadId":"owned"}}),
            );
            let _ = ws.read();
        });
        let socket = SharedSocket::connect_with_limits(
            &path,
            Duration::from_secs(2),
            String::new(),
            None,
            8,
            EVENT_BYTES,
            None,
            true,
            true,
        )
        .unwrap();
        thread::sleep(Duration::from_millis(50));
        let mut socket = socket;
        socket.bind_bootstrap_thread("owned").unwrap();
        let first = socket
            .receive_notification(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        assert_eq!(first["method"], "thread/status/changed");
        drop(socket);
        server.join().unwrap();
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn idle_events_and_approval_admission_scope() {
        let (path, l) = listener();
        let server = thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut ws = tungstenite::accept(s).unwrap();
            send(
                &mut ws,
                json!({"method":"turn/started","params":{"threadId":"t"}}),
            );
            send(
                &mut ws,
                json!({"method":"item/started","params":{"threadId":"t"}}),
            );
            send(
                &mut ws,
                json!({"id":"foreign","method":"item/commandExecution/requestApproval","params":{"threadId":"other"}}),
            );
            send(
                &mut ws,
                json!({"id":"unscoped","method":"item/commandExecution/requestApproval","params":{}}),
            );
            send(
                &mut ws,
                json!({"id":"owned","method":"item/commandExecution/requestApproval","params":{"threadId":"t"}}),
            );
            let response: Value =
                serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(response["id"], "owned");
        });
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let cb: ApprovalAdmission = Arc::new(move |_| {
            c.fetch_add(1, Ordering::SeqCst);
            Some(json!({"decision":"accept"}))
        });
        let socket =
            SharedSocket::connect(&path, Duration::from_secs(2), "t".into(), Some(cb)).unwrap();
        assert_eq!(
            socket
                .receive_notification(Duration::from_secs(2))
                .unwrap()
                .unwrap()["method"],
            "turn/started"
        );
        assert_eq!(
            socket
                .receive_notification(Duration::from_secs(2))
                .unwrap()
                .unwrap()["method"],
            "item/started"
        );
        server.join().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        socket.detach();
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn lost_ack_is_unknown_and_connection_cannot_retry() {
        let (path, l) = listener();
        let server = thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut ws = tungstenite::accept(s).unwrap();
            ws.read().unwrap();
        });
        let mut socket =
            SharedSocket::connect(&path, Duration::from_secs(2), "t".into(), None).unwrap();
        assert_eq!(
            socket.request("turn/start", json!({})),
            Err(SharedSocketError::OutcomeUnknown)
        );
        assert_eq!(
            socket.request("turn/start", json!({})),
            Err(SharedSocketError::Closed)
        );
        server.join().unwrap();
        socket.detach();
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn owned_approval_without_callback_is_silent_and_request_id_routes() {
        let (path, listener) = listener();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            send(
                &mut ws,
                json!({"id":"owned","method":"item/commandExecution/requestApproval","params":{"threadId":"t"}}),
            );
            let request: Value =
                serde_json::from_str(ws.read().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(request["method"], "thread/read");
            send(&mut ws, json!({"id":request["id"],"result":{"ok":true}}));
        });
        let mut socket =
            SharedSocket::connect(&path, Duration::from_secs(2), "t".into(), None).unwrap();
        assert_eq!(
            socket.request("thread/read", json!({})).unwrap()["result"]["ok"],
            true
        );
        server.join().unwrap();
        socket.detach();
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn event_overflow_closes_and_preserves_bounded_prefix() {
        let (path, l) = listener();
        let server = thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut ws = tungstenite::accept(s).unwrap();
            for n in 0..=EVENT_CAPACITY {
                send(
                    &mut ws,
                    json!({"method":"item/started","params":{"threadId":"t","n":n}}),
                );
            }
        });
        let socket =
            SharedSocket::connect(&path, Duration::from_secs(2), "t".into(), None).unwrap();
        server.join().unwrap();
        thread::sleep(Duration::from_millis(150));
        for n in 0..EVENT_CAPACITY {
            assert_eq!(
                socket
                    .receive_notification(Duration::from_secs(1))
                    .unwrap()
                    .unwrap()["params"]["n"],
                n
            );
        }
        assert_eq!(
            socket.receive_notification(Duration::from_secs(1)),
            Err(SharedSocketError::Closed)
        );
        socket.detach();
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn independent_observers_detach_without_closing_listener() {
        let (path, l) = listener();
        let server = thread::spawn(move || {
            let (a, _) = l.accept().unwrap();
            let _a = tungstenite::accept(a).unwrap();
            let (b, _) = l.accept().unwrap();
            let mut b = tungstenite::accept(b).unwrap();
            send(
                &mut b,
                json!({"method":"turn/started","params":{"threadId":"t"}}),
            );
        });
        let a = SharedSocket::connect(&path, Duration::from_secs(2), "t".into(), None).unwrap();
        let b = SharedSocket::connect(&path, Duration::from_secs(2), "t".into(), None).unwrap();
        a.detach();
        assert!(b
            .receive_notification(Duration::from_secs(2))
            .unwrap()
            .is_some());
        b.detach();
        server.join().unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn idle_has_no_periodic_readiness_wake_and_detach_wakes_reader() {
        let (path, listener) = listener();
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            assert!(ws.read().is_err());
        });
        let socket =
            SharedSocket::connect(&path, Duration::from_secs(2), "t".into(), None).unwrap();
        thread::sleep(Duration::from_millis(150));
        assert_eq!(socket.wake_count.load(Ordering::Relaxed), 0);
        let started = Instant::now();
        socket.detach();
        assert!(started.elapsed() < Duration::from_millis(500));
        server.join().unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn event_byte_limit_closes_after_preserving_prefix() {
        let (path, listener) = listener();
        let event =
            json!({"method":"item/started","params":{"threadId":"t","data":"x".repeat(128)}});
        let limit = event.to_string().len() + 1;
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(stream).unwrap();
            send(&mut ws, event.clone());
            send(&mut ws, event);
        });
        let socket = SharedSocket::connect_with_limits(
            &path,
            Duration::from_secs(2),
            "t".into(),
            None,
            8,
            limit,
            None,
            false,
            false,
        )
        .unwrap();
        server.join().unwrap();
        thread::sleep(Duration::from_millis(100));
        assert!(socket
            .receive_notification(Duration::from_secs(1))
            .unwrap()
            .is_some());
        assert_eq!(
            socket.receive_notification(Duration::from_secs(1)),
            Err(SharedSocketError::Closed)
        );
        socket.detach();
        std::fs::remove_file(path).unwrap();
    }
}

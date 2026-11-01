//! Antigravity PRP dispatch and native-result observation. Native results do not
//! constitute a Paperclip structured completion.
use crate::durable::{
    create_private_temporary_file, open_private_regular_file, verify_private_directory, Command,
    CommandExecution, CommandExecutor, DurableRunnerConfig, DurableRunnerError, EventPriority,
};

pub const ANTIGRAVITY_PROVIDER_STATE_FILE: &str = "antigravity-provider-state.json";
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AntigravityBinding {
    pub binding_id: String,
    pub binding_generation: u64,
    pub run_id: String,
    pub environment_lease_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub conversation_id: String,
    pub process_generation: String,
    pub start_command_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    schema: String,
    binding: AntigravityBinding,
    phase: String,
    input_digest: Option<String>,
    result: Option<Value>,
}
pub struct AntigravityDispatchExecutor {
    directory: PathBuf,
    state: State,
}
fn invalid(message: &str) -> DurableRunnerError {
    DurableRunnerError::invalid(message)
}
fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
impl AntigravityDispatchExecutor {
    pub fn from_descriptor(
        directory: &Path,
        config: &DurableRunnerConfig,
        provider: &Value,
    ) -> Result<Self, DurableRunnerError> {
        if provider.get("controllerCapability").and_then(Value::as_str)
            != Some("antigravity-headless-dispatch.v1")
        {
            return Err(invalid("Antigravity controller capability unsupported"));
        }
        let field = |name: &str| {
            provider
                .get(name)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| invalid("Antigravity descriptor invalid"))
        };
        let binding = AntigravityBinding {
            binding_id: field("bindingId")?,
            binding_generation: provider
                .get("bindingGeneration")
                .and_then(Value::as_u64)
                .ok_or_else(|| invalid("Antigravity descriptor invalid"))?,
            run_id: config.run_id.clone(),
            environment_lease_id: config.environment_lease_id.clone(),
            session_id: config.normalized_session_id.clone(),
            turn_id: config.turn_id.clone(),
            conversation_id: field("conversationId")?,
            process_generation: field("processGeneration")?,
            start_command_id: field("startCommandId")?,
        };
        Self::open(directory, binding)
    }
    pub fn restore(
        directory: &Path,
        config: &DurableRunnerConfig,
    ) -> Result<Self, DurableRunnerError> {
        verify_private_directory(directory)?;
        let file = open_private_regular_file(&directory.join(ANTIGRAVITY_PROVIDER_STATE_FILE))
            .map_err(|_| invalid("Antigravity state unavailable"))?;
        let mut bytes = Vec::new();
        file.take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| invalid("Antigravity state read failed"))?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err(invalid("Antigravity state too large"));
        }
        let state: State =
            serde_json::from_slice(&bytes).map_err(|_| invalid("Antigravity state invalid"))?;
        if state.binding.run_id != config.run_id
            || state.binding.environment_lease_id != config.environment_lease_id
            || state.binding.session_id != config.normalized_session_id
            || state.binding.turn_id != config.turn_id
        {
            return Err(invalid("Antigravity restored authority mismatch"));
        }
        Self::open(directory, state.binding)
    }
    pub fn open(directory: &Path, binding: AntigravityBinding) -> Result<Self, DurableRunnerError> {
        verify_private_directory(directory)?;
        if [
            &binding.binding_id,
            &binding.run_id,
            &binding.environment_lease_id,
            &binding.session_id,
            &binding.turn_id,
            &binding.conversation_id,
            &binding.process_generation,
            &binding.start_command_id,
        ]
        .iter()
        .any(|v| v.is_empty() || v.len() > 256)
            || binding.binding_generation == 0
        {
            return Err(invalid("Antigravity binding invalid"));
        }
        let path = directory.join(ANTIGRAVITY_PROVIDER_STATE_FILE);
        let state = match open_private_regular_file(&path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(2 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| invalid("Antigravity state read failed"))?;
                if bytes.len() > 2 * 1024 * 1024 {
                    return Err(invalid("Antigravity state too large"));
                }
                let state: State = serde_json::from_slice(&bytes)
                    .map_err(|_| invalid("Antigravity state invalid"))?;
                if state.schema != "paperclip.runner.antigravity-provider.v1"
                    || state.binding != binding
                    || !["new", "prepared", "open", "offered", "observed", "closed"]
                        .contains(&state.phase.as_str())
                {
                    return Err(invalid("Antigravity state binding mismatch"));
                }
                state
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => State {
                schema: "paperclip.runner.antigravity-provider.v1".into(),
                binding,
                phase: "new".into(),
                input_digest: None,
                result: None,
            },
            Err(_) => return Err(invalid("Antigravity state unavailable")),
        };
        Ok(Self {
            directory: directory.to_path_buf(),
            state,
        })
    }
    fn save(&self) -> Result<(), DurableRunnerError> {
        verify_private_directory(&self.directory)?;
        let path = self.directory.join(ANTIGRAVITY_PROVIDER_STATE_FILE);
        let bytes = serde_json::to_vec(&self.state)
            .map_err(|_| invalid("Antigravity state encoding failed"))?;
        let (temporary, mut file) = create_private_temporary_file(&path)?;
        let result = (|| -> std::io::Result<()> {
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, &path)?;
            File::open(&self.directory)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
            return Err(invalid("Antigravity state commit failed"));
        }
        Ok(())
    }
}
impl CommandExecutor for AntigravityDispatchExecutor {
    fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
        if self.state.phase == "closed" {
            Ok(())
        } else {
            Err(invalid("Antigravity controller exit not yet proven"))
        }
    }
    fn execute(&mut self, command: &Command) -> Result<CommandExecution, DurableRunnerError> {
        let b = &self.state.binding;
        match command.command_type.as_str() {
            "run.prepare" => {
                if command.payload.get("provider")
                    != Some(
                        &json!({"kind":"antigravity_headless","conversationId":b.conversation_id,"processGeneration":b.process_generation,"bindingId":b.binding_id,"bindingGeneration":b.binding_generation,"startCommandId":b.start_command_id,"controllerCapability":"antigravity-headless-dispatch.v1"}),
                    )
                {
                    return Err(invalid("Antigravity prepare binding mismatch"));
                }
                if self.state.phase == "new" {
                    self.state.phase = "prepared".into();
                    self.save()?;
                }
                Ok(CommandExecution::result(
                    json!({"status":"prepared","controllerCapability":"antigravity-headless-dispatch.v1"}),
                ))
            }
            "session.open" => {
                if self.state.phase == "prepared" {
                    self.state.phase = "open".into();
                    self.save()?;
                } else if self.state.phase != "open" {
                    return Err(invalid("Antigravity session not prepared"));
                }
                Ok(CommandExecution::result(
                    json!({"status":"started","providerSessionId":self.state.binding.conversation_id}),
                ))
            }
            "turn.start" => {
                if command.command_id != b.start_command_id {
                    return Err(invalid("Antigravity command outside exact admitted turn"));
                }
                let text = command
                    .payload
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|v| {
                        !v.is_empty()
                            && v.len() <= 1024 * 1024
                            && !v.starts_with('/')
                            && !v.contains('\0')
                    })
                    .ok_or_else(|| invalid("Antigravity input invalid"))?;
                let input_digest = digest(text);
                if self.state.phase == "open" {
                    self.state.input_digest = Some(input_digest.clone());
                    self.state.phase = "offered".into();
                    self.save()?;
                } else if self.state.phase != "offered"
                    || self.state.input_digest.as_deref() != Some(&input_digest)
                {
                    return Err(invalid("Antigravity turn already used"));
                }
                let b = &self.state.binding;
                Ok(CommandExecution {
                    result: json!({"status":"dispatch_requested","providerTurnId":b.turn_id}),
                    events: vec![(
                        "native_controller.dispatch_requested".into(),
                        EventPriority::P0,
                        json!({"binding":{"bindingId":b.binding_id,"bindingGeneration":b.binding_generation,"runId":b.run_id,"environmentLeaseId":b.environment_lease_id,"normalizedSessionId":b.session_id,"turnId":b.turn_id},"text":text,"inputDigest":format!("sha256:{}", input_digest)}),
                    )],
                })
            }
            "native_controller.observation" => {
                let p = &command.payload;
                if p["bindingId"] != b.binding_id
                    || p["bindingGeneration"] != b.binding_generation
                    || p["runId"] != b.run_id
                    || p["environmentLeaseId"] != b.environment_lease_id
                    || p["normalizedSessionId"] != b.session_id
                    || p["turnId"] != b.turn_id
                    || p["conversationId"] != b.conversation_id
                    || p["processGeneration"] != b.process_generation
                {
                    return Err(invalid("Antigravity result binding mismatch"));
                }
                if p["action"] == "antigravity.provider_exit" {
                    if p["exitObserved"] != true {
                        return Err(invalid("Antigravity exit unproven"));
                    }
                    if self.state.phase != "closed" {
                        self.state.phase = "closed".into();
                        self.save()?;
                    }
                    return Ok(CommandExecution::result(
                        json!({"status":"closed","providerExitConfirmed":true,"providerSessionId":self.state.binding.conversation_id}),
                    ));
                }
                if p["action"] != "antigravity.native_result"
                    || !p["dispatchEventId"].as_str().is_some_and(|v| !v.is_empty())
                {
                    return Err(invalid("Antigravity result invalid"));
                }
                let result = &p["result"];
                if !result["status"].as_str().is_some_and(|v| !v.is_empty())
                    || result.get("response").is_some_and(|v| !v.is_string())
                    || serde_json::to_vec(result).map_or(true, |v| v.len() > 1024 * 1024)
                {
                    return Err(invalid("Antigravity result invalid"));
                }
                if self.state.phase == "offered" {
                    self.state.result = Some(result.clone());
                    self.state.phase = "observed".into();
                    self.save()?;
                } else if self.state.phase != "observed"
                    || self.state.result.as_ref() != Some(result)
                {
                    return Err(invalid("Antigravity result conflict"));
                }
                let mut events = vec![(
                    "harness.diagnostic".into(),
                    EventPriority::P0,
                    json!({"code":"antigravity_native_result_observed","nativeStatus":result["status"],"paperclipCompletion":"unverified"}),
                )];
                if let Some(response) = result.get("response").and_then(Value::as_str) {
                    events.push(("item.completed".into(), EventPriority::P1,
                        json!({"provider":"antigravity_headless","item":{"id":self.state.binding.turn_id,"type":"agentMessage","text":response,"phase":"commentary"}})));
                }
                Ok(CommandExecution {
                    result: json!({"status":"native_result_observed","paperclipCompletion":"unverified"}),
                    events,
                })
            }
            "session.snapshot" => Ok(CommandExecution::result(
                json!({"status":self.state.phase,"providerSessionId":self.state.binding.conversation_id,"paperclipCompletion":"unverified"}),
            )),
            "session.close" | "runner.suspend" | "runner.shutdown"
                if self.state.phase == "closed" =>
            {
                Ok(CommandExecution::result(
                    json!({"status":"closed","providerExitConfirmed":true,"providerSessionId":self.state.binding.conversation_id}),
                ))
            }
            _ => Err(invalid("Antigravity command unsupported")),
        }
    }
}

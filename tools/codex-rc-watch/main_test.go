package main

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"
)

type fakeControl struct {
	mu       sync.Mutex
	methods  []string
	enabled  bool
	polls    int
	initial  string
	drop     bool
	fragment bool
}

func temporaryDir(t *testing.T) string {
	t.Helper()
	path, err := os.MkdirTemp(os.TempDir(), "rcw-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(path) })
	return path
}

func fakeHome(t *testing.T, initial string) (string, *fakeControl) {
	t.Helper()
	home := temporaryDir(t)
	control := filepath.Join(home, "app-server-control")
	if err := os.Mkdir(control, 0700); err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(control, "app-server-control.sock")
	listener, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeControl{initial: initial}
	done := make(chan struct{})
	t.Cleanup(func() { listener.Close(); <-done })
	go func() {
		defer close(done)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(3 * time.Second))
		reader := bufio.NewReader(conn)
		req, err := http.ReadRequest(reader)
		if err != nil {
			return
		}
		sum := sha1.Sum([]byte(req.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
		fmt.Fprintf(conn, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", base64.StdEncoding.EncodeToString(sum[:]))
		for {
			payload, err := readClientFrame(reader)
			if err != nil {
				return
			}
			var msg struct {
				ID     *int            `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			if json.Unmarshal(payload, &msg) != nil {
				return
			}
			fake.mu.Lock()
			fake.methods = append(fake.methods, msg.Method)
			var result any
			closeAfter := false
			switch msg.Method {
			case "initialize":
				result = map[string]string{"userAgent": "codex/0.166.0", "platformFamily": "unix"}
			case "initialized":
				fake.mu.Unlock()
				continue
			case "remoteControl/status/read":
				status := fake.initial
				if fake.enabled {
					fake.polls++
					status = "connecting"
					if fake.polls > 1 {
						status = "connected"
					}
				}
				result = map[string]string{"status": status, "serverName": "hidden", "installationId": "hidden"}
				closeAfter = fake.drop
			case "remoteControl/enable":
				var params struct {
					Ephemeral bool `json:"ephemeral"`
				}
				if json.Unmarshal(msg.Params, &params) != nil || !params.Ephemeral {
					fake.mu.Unlock()
					return
				}
				fake.enabled = true
				result = map[string]string{"status": "connecting"}
			default:
				fake.mu.Unlock()
				return
			}
			fragment := fake.fragment && msg.Method == "remoteControl/status/read"
			fake.mu.Unlock()
			b, _ := json.Marshal(map[string]any{"id": msg.ID, "result": result})
			if fragment {
				writeServerFrame(conn, 0x89, []byte("p"))
				writeServerFrame(conn, 0x01, b[:len(b)/2])
				writeServerFrame(conn, 0x80, b[len(b)/2:])
			} else {
				writeServerFrame(conn, 0x81, b)
			}
			if closeAfter {
				return
			}
		}
	}()
	return home, fake
}

func readClientFrame(r io.Reader) ([]byte, error) {
	var head [2]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return nil, err
	}
	if head[1]&128 == 0 {
		return nil, errProtocol
	}
	size := int(head[1] & 127)
	if size == 126 {
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return nil, err
		}
		size = int(binary.BigEndian.Uint16(ext[:]))
	} else if size == 127 {
		return nil, errProtocol
	}
	var mask [4]byte
	if _, err := io.ReadFull(r, mask[:]); err != nil {
		return nil, err
	}
	b := make([]byte, size)
	if _, err := io.ReadFull(r, b); err != nil {
		return nil, err
	}
	for i := range b {
		b[i] ^= mask[i%4]
	}
	if head[0]&15 == 10 {
		return readClientFrame(r)
	}
	return b, nil
}

func writeServerFrame(w io.Writer, op byte, payload []byte) {
	header := []byte{op}
	if len(payload) < 126 {
		header = append(header, byte(len(payload)))
	} else {
		header = append(header, 126, byte(len(payload)>>8), byte(len(payload)))
	}
	w.Write(append(header, payload...))
}

func (f *fakeControl) snapshot() ([]string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.methods...), f.enabled
}

func TestReadOnlyCheckConnectedAndDisabled(t *testing.T) {
	for _, status := range []string{"connected", "disabled"} {
		t.Run(status, func(t *testing.T) {
			home, fake := fakeHome(t, status)
			var out, stderr bytes.Buffer
			code := run([]string{"--check", "--home", home}, &out, &stderr)
			wantCode := 1
			if status == "connected" {
				wantCode = 0
			}
			if code != wantCode || stderr.Len() != 0 {
				t.Fatalf("code=%d stderr=%s", code, &stderr)
			}
			var result checkResult
			if json.Unmarshal(out.Bytes(), &result) != nil || result.Status != status || result.SocketPath == "" {
				t.Fatalf("invalid result %s", &out)
			}
			methods, enabled := fake.snapshot()
			want := []string{"initialize", "initialized", "remoteControl/status/read"}
			if enabled || !reflect.DeepEqual(methods, want) {
				t.Fatalf("mutating check: %v", methods)
			}
		})
	}
}

func TestDisabledRepairOnSameConnectionWaitsForConnected(t *testing.T) {
	home, fake := fakeHome(t, "disabled")
	event := observe(home, time.Second, time.Second)
	if event.Event != "rc_disabled_repaired" || event.Status != "connected" || event.Error != "" {
		t.Fatalf("repair=%+v", event)
	}
	methods, enabled := fake.snapshot()
	want := []string{"initialize", "initialized", "remoteControl/status/read", "remoteControl/enable", "remoteControl/status/read", "remoteControl/status/read"}
	if !enabled || !reflect.DeepEqual(methods, want) {
		t.Fatalf("methods=%v", methods)
	}
}

func TestHealthyDaemonIsQuietAndReadOnly(t *testing.T) {
	home, fake := fakeHome(t, "connected")
	event := observe(home, time.Second, time.Second)
	path := filepath.Join(temporaryDir(t), "exceptions.jsonl")
	log := exceptionLog{path: path, maxBytes: 4096}
	if err := log.record(event); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("healthy log exists: %v", err)
	}
	methods, enabled := fake.snapshot()
	if enabled || len(methods) != 3 || event.Event != "" {
		t.Fatalf("healthy mutated: %v %+v", methods, event)
	}
}

func TestAbsentDaemonStaysAbsentAndQuiet(t *testing.T) {
	home := temporaryDir(t)
	result := check(home, time.Second)
	if result.Status == "connected" || result.Error != "absent" {
		t.Fatalf("check=%+v", result)
	}
	event := observe(home, time.Second, time.Second)
	if event.Event != "" {
		t.Fatalf("absent exception=%+v", event)
	}
	entries, err := os.ReadDir(home)
	if err != nil || len(entries) != 0 {
		t.Fatalf("absent home changed: %v %v", entries, err)
	}
}

func TestDaemonCloseRaceFailsWithoutReconnect(t *testing.T) {
	home, fake := fakeHome(t, "disabled")
	fake.mu.Lock()
	fake.drop = true
	fake.mu.Unlock()
	event := observe(home, time.Second, time.Second)
	_, enabled := fake.snapshot()
	if enabled || event.Error == "" || event.Event == "rc_disabled_repaired" {
		t.Fatalf("race accepted or reconnected: %+v", event)
	}
}

func TestNonDisabledStatesNeverEnable(t *testing.T) {
	for _, status := range []string{"connecting", "errored", "future-status"} {
		t.Run(status, func(t *testing.T) {
			home, fake := fakeHome(t, status)
			event := observe(home, time.Second, time.Second)
			_, enabled := fake.snapshot()
			if enabled || event.Event == "" {
				t.Fatalf("unsafe status handling: %+v", event)
			}
			if status == "future-status" && event.Error != "protocol_error" {
				t.Fatalf("unknown status accepted: %+v", event)
			}
		})
	}
}

func TestFragmentedStatusAndPing(t *testing.T) {
	home, fake := fakeHome(t, "connected")
	fake.mu.Lock()
	fake.fragment = true
	fake.mu.Unlock()
	result := check(home, time.Second)
	if result.Status != "connected" || result.Error != "" {
		t.Fatalf("framing=%+v", result)
	}
}

func TestExceptionsDeduplicateAndRotate(t *testing.T) {
	path := filepath.Join(temporaryDir(t), "exceptions.jsonl")
	log := exceptionLog{path: path, maxBytes: 150}
	event := observation{Home: "/test", Event: "rc_errored", Status: "errored"}
	if err := log.record(event); err != nil {
		t.Fatal(err)
	}
	first, _ := os.ReadFile(path)
	if err := log.record(event); err != nil {
		t.Fatal(err)
	}
	second, _ := os.ReadFile(path)
	if !bytes.Equal(first, second) {
		t.Fatal("duplicate exception logged")
	}
	event.Event = "rc_connecting"
	if err := log.record(event); err != nil {
		t.Fatal(err)
	}
	rotated, err := os.ReadFile(path + ".1")
	if err != nil || !bytes.Equal(rotated, first) {
		t.Fatalf("rotation failed: %v", err)
	}
	if err := log.record(observation{Home: "/test"}); err != nil {
		t.Fatal(err)
	}
	if len(log.last) != 0 {
		t.Fatal("healthy state not cleared")
	}
}

func TestInvalidConfigExceptionIsVisibleAndBounded(t *testing.T) {
	dir := temporaryDir(t)
	logPath := filepath.Join(dir, "launchd-errors.log")
	if err := os.WriteFile(logPath, bytes.Repeat([]byte("x"), 64<<10), 0600); err != nil {
		t.Fatal(err)
	}
	var out, stderr bytes.Buffer
	code := run([]string{"--config", filepath.Join(dir, "missing.json")}, &out, &stderr)
	if code != 2 || out.Len() != 0 || stderr.Len() != 0 {
		t.Fatalf("code=%d out=%q stderr=%q", code, &out, &stderr)
	}
	b, err := os.ReadFile(logPath)
	if err != nil || string(b) != "codex-rc-watch: invalid_config\n" {
		t.Fatalf("startup exception missing: %q %v", b, err)
	}
	info, err := os.Stat(logPath + ".1")
	if err != nil || info.Size() != 64<<10 {
		t.Fatalf("startup log not bounded: %v", err)
	}
}

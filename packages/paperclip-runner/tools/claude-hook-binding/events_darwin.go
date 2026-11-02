//go:build darwin

package main

import (
	"bufio"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

type hookEvent struct {
	SessionID   string  `json:"session_id"`
	Cwd         string  `json:"cwd"`
	Event       string  `json:"hook_event_name"`
	PromptID    *string `json:"prompt_id"`
	ToolUseID   *string `json:"tool_use_id"`
	AgentID     *string `json:"agent_id"`
	Interrupted *bool   `json:"is_interrupt"`
}
type eventEnvelope struct {
	Hook        hookEvent `json:"hook"`
	Nonce       string    `json:"nonce"`
	DeliveryKey string    `json:"deliveryKey"`
}
type ack struct {
	DeliveryKey string `json:"deliveryKey"`
	Status      string `json:"status"`
}

func validHook(h hookEvent) bool {
	switch h.Event {
	case "UserPromptSubmit", "Stop", "StopFailure":
		return h.ToolUseID == nil && h.Interrupted == nil
	case "PreToolUse", "PostToolUse", "PermissionDenied":
		return h.ToolUseID != nil && len(*h.ToolUseID) > 0 && len(*h.ToolUseID) <= 256 && h.Interrupted == nil
	case "PostToolUseFailure":
		return h.ToolUseID != nil && len(*h.ToolUseID) > 0 && len(*h.ToolUseID) <= 256
	default:
		return false
	}
}
func receiveEvents() error {
	reader := bufio.NewReaderSize(os.Stdin, 8192)
	raw, e := reader.ReadSlice('\n')
	if e != nil || len(raw) > 8192 {
		return errors.New("invalid scope")
	}
	var s scope
	if json.Unmarshal(raw, &s) != nil || s.PID < 1 || !uuid.MatchString(s.SessionID) || !noncePattern.MatchString(s.Nonce) || !filepath.IsAbs(s.Cwd) || !filepath.IsAbs(s.Executable) || !filepath.IsAbs(s.Home) || !filepath.IsAbs(s.Config) || !filepath.IsAbs(s.Socket) {
		return errors.New("invalid scope")
	}
	if e = privateDir(filepath.Dir(s.Socket)); e != nil {
		return e
	}
	if _, e = os.Lstat(s.Socket); !os.IsNotExist(e) {
		return errors.New("socket exists")
	}
	if e = verifyOwner(s); e != nil {
		return e
	}
	owner, e := inspect(s.PID)
	if e != nil {
		return e
	}
	l, e := net.ListenUnix("unix", &net.UnixAddr{Name: s.Socket, Net: "unix"})
	if e != nil {
		return e
	}
	defer l.Close()
	l.SetUnlinkOnClose(true)
	if e = os.Chmod(s.Socket, 0600); e != nil {
		return e
	}
	acks := make(chan string)
	go func() {
		defer close(acks)
		defer l.Close()
		for {
			line, err := reader.ReadSlice('\n')
			if err != nil || len(line) > 1024 {
				return
			}
			acks <- string(line)
		}
	}()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(signals)
	go func() {
		select {
		case <-signals:
			l.Close()
		case <-time.After(24 * time.Hour):
			l.Close()
		}
	}()
	if _, e = fmt.Fprintln(os.Stdout, `{"type":"ready"}`); e != nil {
		return e
	}
	g := Guard{Owner: owner, UID: uint32(os.Getuid())}
	for count := 0; count < 4096; count++ {
		c, err := l.AcceptUnix()
		if err != nil {
			return err
		}
		err = handleEvent(c, s, &g, acks)
		_ = c.Close()
		if err != nil {
			return err
		}
	}
	return errors.New("event capacity")
}
func handleEvent(c *net.UnixConn, s scope, g *Guard, acks <-chan string) error {
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	pid, e := peerPID(c)
	if e != nil {
		return e
	}
	uid, e := peerUID(c)
	if e != nil || uid != g.UID {
		return errors.New("peer uid")
	}
	before, e := inspect(pid)
	if e != nil {
		return e
	}
	if e = g.ancestry(pid); e != nil {
		return e
	}
	data, e := io.ReadAll(io.LimitReader(c, 8193))
	if e != nil || len(data) > 8192 {
		return errors.New("event payload")
	}
	var v eventEnvelope
	if json.Unmarshal(data, &v) != nil || v.Hook.SessionID != s.SessionID || v.Hook.Cwd != s.Cwd || len(v.Nonce) != len(s.Nonce) || subtle.ConstantTimeCompare([]byte(v.Nonce), []byte(s.Nonce)) != 1 || !noncePattern.MatchString(v.DeliveryKey) || !validHook(v.Hook) {
		return errors.New("event binding")
	}
	if v.Hook.PromptID != nil && !uuid.MatchString(*v.Hook.PromptID) {
		return errors.New("prompt id")
	}
	if v.Hook.AgentID != nil && (len(*v.Hook.AgentID) == 0 || len(*v.Hook.AgentID) > 128) {
		return errors.New("agent id")
	}
	after, e := inspect(pid)
	if e != nil || after != before {
		return errors.New("peer changed")
	}
	if e = g.ancestry(pid); e != nil {
		return e
	}
	if e = verifyOwner(s); e != nil {
		return e
	}
	frame := map[string]any{"type": "event", "deliveryKey": v.DeliveryKey, "sessionId": s.SessionID, "processGeneration": s.Generation, "event": v.Hook.Event, "promptId": v.Hook.PromptID, "toolUseId": v.Hook.ToolUseID, "agentId": v.Hook.AgentID, "interrupted": v.Hook.Interrupted}
	if e = json.NewEncoder(os.Stdout).Encode(frame); e != nil {
		return e
	}
	select {
	case line, ok := <-acks:
		if !ok {
			return errors.New("parent closed")
		}
		var a ack
		if json.Unmarshal([]byte(line), &a) != nil || a.DeliveryKey != v.DeliveryKey || a.Status != "persisted" {
			return errors.New("append not acknowledged")
		}
	case <-time.After(5 * time.Second):
		return errors.New("append deadline")
	}
	// A vanished sender after durable append may reconnect with the same key.
	// The parent deduplicates it; a broken response is not a listener failure.
	_, _ = io.WriteString(c, "OK\n")
	return nil
}
func sendEvent() error {
	socket, nonceFile := os.Getenv("CLAUDE_HOOK_SOCKET"), os.Getenv("CLAUDE_HOOK_NONCE_FILE")
	if !filepath.IsAbs(socket) || !filepath.IsAbs(nonceFile) {
		return errors.New("hook paths")
	}
	st, e := os.Lstat(nonceFile)
	if e != nil || !st.Mode().IsRegular() || st.Mode().Perm() != 0600 {
		return errors.New("nonce file")
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok || sys.Uid != uint32(os.Getuid()) {
		return errors.New("nonce owner")
	}
	nonce, e := os.ReadFile(nonceFile)
	if e != nil || !noncePattern.Match(nonce) {
		return errors.New("nonce")
	}
	raw, e := io.ReadAll(io.LimitReader(os.Stdin, 262145))
	if e != nil || len(raw) > 262144 {
		return errors.New("hook input")
	}
	var h hookEvent
	if json.Unmarshal(raw, &h) != nil || !validHook(h) {
		return errors.New("hook event")
	}
	var random [32]byte
	if _, e = rand.Read(random[:]); e != nil {
		return e
	}
	payload, e := json.Marshal(eventEnvelope{Hook: h, Nonce: string(nonce), DeliveryKey: hex.EncodeToString(random[:])})
	if e != nil || len(payload) > 8192 {
		return errors.New("event size")
	}
	deadline := time.Now().Add(8 * time.Second)
	var last error
	for attempt := 0; attempt < 2 && time.Now().Before(deadline); {
		c, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: socket, Net: "unix"})
		if err != nil {
			last = err
			time.Sleep(100 * time.Millisecond)
			continue
		}
		attempt++
		_ = c.SetDeadline(deadline)
		_, err = c.Write(payload)
		if err == nil {
			err = c.CloseWrite()
		}
		var response string
		if err == nil {
			response, err = bufio.NewReader(io.LimitReader(c, 16)).ReadString('\n')
		}
		_ = c.Close()
		if err == nil && response == "OK\n" {
			return nil
		}
		last = errors.New("no durable acknowledgment")
	}
	if last != nil {
		return last
	}
	return errors.New("delivery failed")
}

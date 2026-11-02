//go:build darwin

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type scope struct {
	Socket, Nonce, SessionID, Cwd, Executable, Generation, Home, Config string
	PID                                                                 int
}

var uuid = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var noncePattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func command(name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second*2)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = []string{"PATH=/usr/bin:/bin:/usr/sbin", "LC_ALL=C"}
	b, e := cmd.Output()
	if e != nil || len(b) > 4096 {
		return "", errors.New("process evidence unavailable")
	}
	return strings.TrimSpace(string(b)), nil
}
func verifyOwner(s scope) error {
	p, e := inspect(s.PID)
	prefix := strconv.Itoa(s.PID) + ":"
	if e != nil || !strings.HasPrefix(s.Generation, prefix) || strings.Join(strings.Fields(strings.TrimPrefix(s.Generation, prefix)), " ") != p.Birth {
		return errors.New("owner generation mismatch")
	}
	executable, e := command("/bin/ps", "-p", strconv.Itoa(s.PID), "-o", "comm=")
	if e != nil {
		return e
	}
	actual, e := filepath.EvalSymlinks(executable)
	if e != nil {
		return e
	}
	expected, e := filepath.EvalSymlinks(s.Executable)
	if e != nil || actual != expected {
		return errors.New("owner executable mismatch")
	}
	cwd, e := command("/usr/sbin/lsof", "-a", "-p", strconv.Itoa(s.PID), "-d", "cwd", "-Fn")
	if e != nil {
		return e
	}
	matches := 0
	for _, line := range strings.Split(cwd, "\n") {
		if strings.HasPrefix(line, "n") {
			actual, e := filepath.EvalSymlinks(line[1:])
			if e != nil || actual != s.Cwd {
				return errors.New("owner cwd mismatch")
			}
			matches++
		}
	}
	if matches != 1 {
		return errors.New("owner cwd unavailable")
	}
	return nil
}
func privateDir(path string) error {
	st, e := os.Lstat(path)
	if e != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 || st.Mode().Perm()&0077 != 0 {
		return errors.New("socket directory is not private")
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok || sys.Uid != uint32(os.Getuid()) {
		return errors.New("socket directory owner mismatch")
	}
	return nil
}
func receive() error {
	data, e := io.ReadAll(io.LimitReader(os.Stdin, 8193))
	if e != nil || len(data) > 8192 {
		return errors.New("invalid scope")
	}
	var s scope
	if json.Unmarshal(data, &s) != nil || s.PID < 1 || !uuid.MatchString(s.SessionID) || !noncePattern.MatchString(s.Nonce) || !filepath.IsAbs(s.Cwd) || !filepath.IsAbs(s.Executable) || !filepath.IsAbs(s.Home) || !filepath.IsAbs(s.Config) || !filepath.IsAbs(s.Socket) {
		return errors.New("invalid scope")
	}
	if e = privateDir(filepath.Dir(s.Socket)); e != nil {
		return e
	}
	if _, e = os.Lstat(s.Socket); !os.IsNotExist(e) {
		return errors.New("socket already exists")
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
	_ = l.SetDeadline(time.Now().Add(15 * time.Second))
	fmt.Fprintln(os.Stdout, `{"status":"ready"}`)
	c, e := l.AcceptUnix()
	if e != nil {
		return e
	}
	defer c.Close()
	g := Guard{Owner: owner, SessionID: s.SessionID, Cwd: s.Cwd, Nonce: s.Nonce, UID: uint32(os.Getuid())}
	if e = g.Accept(c); e != nil {
		return e
	}
	if e = verifyOwner(s); e != nil {
		return e
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"status": "accepted", "sessionId": s.SessionID, "pid": s.PID, "generation": s.Generation, "cwd": s.Cwd, "executable": s.Executable, "home": s.Home, "config": s.Config, "peer": "darwin-kernel-pid-uid-and-live-ancestry", "namespace": "parent-attested-launch-scope", "event": "SessionStart"})
}
func send() error {
	socket, nonceFile := os.Getenv("CLAUDE_HOOK_SOCKET"), os.Getenv("CLAUDE_HOOK_NONCE_FILE")
	if !filepath.IsAbs(socket) || !filepath.IsAbs(nonceFile) {
		return errors.New("missing hook paths")
	}
	st, e := os.Lstat(nonceFile)
	if e != nil || !st.Mode().IsRegular() || st.Mode().Perm() != 0600 {
		return errors.New("invalid nonce file")
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok || sys.Uid != uint32(os.Getuid()) {
		return errors.New("invalid nonce owner")
	}
	nonce, e := os.ReadFile(nonceFile)
	if e != nil || !noncePattern.Match(nonce) {
		return errors.New("invalid nonce")
	}
	data, e := io.ReadAll(io.LimitReader(os.Stdin, maxPayload+1))
	if e != nil || len(data) > maxPayload {
		return errors.New("invalid hook input")
	}
	var r Record
	if json.Unmarshal(data, &r) != nil {
		return errors.New("invalid hook json")
	}
	r.Nonce = string(nonce)
	data, e = json.Marshal(r)
	if e != nil {
		return e
	}
	var c *net.UnixConn
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		c, e = net.DialUnix("unix", nil, &net.UnixAddr{Name: socket, Net: "unix"})
		if e == nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if e != nil {
		return e
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	_, e = c.Write(data)
	if e != nil {
		return e
	}
	if e = c.CloseWrite(); e != nil {
		return e
	}
	_, e = io.Copy(io.Discard, io.LimitReader(c, 1))
	return e
}
func main() {
	var e error
	if len(os.Args) == 2 && os.Args[1] == "events" {
		e = receiveEvents()
	} else if len(os.Args) == 2 && os.Args[1] == "send-event" {
		e = sendEvent()
	} else if len(os.Args) == 2 && os.Args[1] == "send" {
		e = send()
	} else if len(os.Args) == 1 {
		e = receive()
	} else {
		e = errors.New("invalid invocation")
	}
	if e != nil {
		fmt.Fprintln(os.Stderr, "hook binding failed")
		os.Exit(1)
	}
}

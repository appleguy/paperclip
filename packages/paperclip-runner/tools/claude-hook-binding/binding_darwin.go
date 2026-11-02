//go:build darwin

// This code verifies an authenticated local hook peer.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const maxPayload = 4096
const localPeerPID = 2 // <sys/un.h>: LOCAL_PEERPID, level SOL_LOCAL=0.

type Record struct {
	SessionID string `json:"session_id"`
	Cwd       string `json:"cwd"`
	Event     string `json:"hook_event_name"`
	Nonce     string `json:"nonce"`
}
type Process struct {
	PID, PPID int
	Birth     string
}
type Guard struct {
	Owner                 Process
	SessionID, Cwd, Nonce string
	UID                   uint32
	mu                    sync.Mutex
	consumed              bool
}

func inspect(pid int) (Process, error) {
	if pid <= 0 {
		return Process{}, errors.New("invalid pid")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/bin/ps", "-p", strconv.Itoa(pid), "-o", "ppid=", "-o", "lstart=")
	cmd.Env = []string{"PATH=/usr/bin:/bin", "LC_ALL=C"}
	out, err := cmd.Output()
	if err != nil || len(out) > 4096 {
		return Process{}, errors.New("process unavailable")
	}
	parts := strings.Fields(string(out))
	if len(parts) != 6 {
		return Process{}, errors.New("invalid process metadata")
	}
	ppid, err := strconv.Atoi(parts[0])
	if err != nil {
		return Process{}, err
	}
	return Process{PID: pid, PPID: ppid, Birth: strings.Join(parts[1:], " ")}, nil
}
func peerPID(c *net.UnixConn) (int, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return 0, err
	}
	var pid int
	var sockerr error
	err = raw.Control(func(fd uintptr) { pid, sockerr = syscall.GetsockoptInt(int(fd), 0, localPeerPID) })
	if err != nil {
		return 0, err
	}
	if sockerr != nil {
		return 0, sockerr
	}
	if pid <= 0 {
		return 0, errors.New("invalid peer pid")
	}
	return pid, nil
}
func peerUID(c *net.UnixConn) (uint32, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return 0, err
	}
	var data [128]byte
	size := uint32(len(data))
	var errno syscall.Errno
	err = raw.Control(func(fd uintptr) {
		_, _, errno = syscall.Syscall6(syscall.SYS_GETSOCKOPT, fd, 0, 1, uintptr(unsafe.Pointer(&data[0])), uintptr(unsafe.Pointer(&size)), 0)
	})
	if err != nil {
		return 0, err
	}
	if errno != 0 {
		return 0, errno
	}
	if size < 8 || binary.LittleEndian.Uint32(data[:4]) != 0 {
		return 0, errors.New("invalid peer credential")
	}
	return binary.LittleEndian.Uint32(data[4:8]), nil
}
func (g *Guard) ancestry(peer int) error {
	// Require the live peer's bounded ancestry to reach the exact owned PID and birth.
	current := peer
	seen := map[int]bool{}
	for i := 0; i < 16; i++ {
		if seen[current] {
			return errors.New("ancestry loop")
		}
		seen[current] = true
		p, err := inspect(current)
		if err != nil {
			return err
		}
		if p.PID == g.Owner.PID {
			if p.Birth != g.Owner.Birth {
				return errors.New("owner generation mismatch")
			}
			return nil
		}
		if p.PPID <= 1 {
			return errors.New("peer outside owner ancestry")
		}
		current = p.PPID
	}
	return errors.New("ancestry depth exceeded")
}
func (g *Guard) Accept(c *net.UnixConn) error {
	_ = c.SetDeadline(time.Now().Add(2 * time.Second))
	pid, err := peerPID(c)
	if err != nil {
		return err
	}
	uid, err := peerUID(c)
	if err != nil || uid != g.UID {
		return errors.New("peer uid mismatch")
	}
	before, err := inspect(pid)
	if err != nil {
		return err
	}
	if err = g.ancestry(pid); err != nil {
		return err
	}
	data, err := io.ReadAll(io.LimitReader(c, maxPayload+1))
	if err != nil || len(data) > maxPayload {
		return errors.New("invalid bounded payload")
	}
	var r Record
	if err = json.Unmarshal(data, &r); err != nil {
		return errors.New("invalid json")
	}
	if r.Event != "SessionStart" || r.SessionID != g.SessionID || r.Cwd != g.Cwd || len(r.Nonce) != len(g.Nonce) || subtle.ConstantTimeCompare([]byte(r.Nonce), []byte(g.Nonce)) != 1 {
		return errors.New("receipt mismatch")
	}
	after, err := inspect(pid)
	if err != nil || after != before {
		return errors.New("peer generation changed")
	}
	if err = g.ancestry(pid); err != nil {
		return err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.consumed {
		return errors.New("nonce consumed")
	}
	g.consumed = true
	return nil
}
func generation(pid int) (Process, error) {
	p, err := inspect(pid)
	if err != nil {
		return Process{}, fmt.Errorf("read generation: %w", err)
	}
	return p, nil
}

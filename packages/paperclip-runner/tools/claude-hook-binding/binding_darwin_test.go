//go:build darwin

package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestChild(t *testing.T) {
	switch os.Getenv("HOOK_PROOF_ROLE") {
	case "hook":
		c, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: os.Getenv("HOOK_PROOF_SOCKET"), Net: "unix"})
		if err != nil {
			os.Exit(3)
		}
		_ = json.NewEncoder(c).Encode(Record{SessionID: "session", Cwd: "/workspace", Event: "SessionStart", Nonce: os.Getenv("HOOK_PROOF_NONCE")})
		_ = c.CloseWrite()
		var b [1]byte
		_, _ = c.Read(b[:])
		_ = c.Close()
		os.Exit(0)
	case "owner":
		fmt.Println("ready")
		sc := bufio.NewScanner(os.Stdin)
		for sc.Scan() {
			if sc.Text() != "send" && sc.Text() != "bad" {
				break
			}
			cmd := exec.Command(os.Args[0], "-test.run=^TestChild$")
			cmd.Env = append(os.Environ(), "HOOK_PROOF_ROLE=hook")
			if sc.Text() == "bad" {
				cmd.Env = append(cmd.Env, "HOOK_PROOF_NONCE=wrong")
			}
			if err := cmd.Run(); err != nil {
				os.Exit(4)
			}
			fmt.Println("done")
		}
		os.Exit(0)
	}
}
func TestKernelPeerAncestryAndNonce(t *testing.T) {
	dir := t.TempDir()
	socket := filepath.Join(dir, "sock")
	if len(socket) > 100 {
		t.Fatal("socket path too long")
	}
	l, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	_ = os.Chmod(socket, 0600)
	nonceBytes := make([]byte, 32)
	if _, err = rand.Read(nonceBytes); err != nil {
		t.Fatal(err)
	}
	nonce := hex.EncodeToString(nonceBytes)
	env := append(os.Environ(), "HOOK_PROOF_SOCKET="+socket, "HOOK_PROOF_NONCE="+nonce)
	owner := exec.Command(os.Args[0], "-test.run=^TestChild$")
	owner.Env = append(env, "HOOK_PROOF_ROLE=owner")
	in, err := owner.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := owner.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = owner.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = fmt.Fprintln(in, "exit"); _ = in.Close(); _ = owner.Wait() }()
	scanner := bufio.NewScanner(out)
	if !scanner.Scan() || scanner.Text() != "ready" {
		t.Fatal("owner not ready")
	}
	ownerIdentity, err := generation(owner.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	guard := &Guard{Owner: ownerIdentity, SessionID: "session", Cwd: "/workspace", Nonce: nonce, UID: uint32(os.Getuid())}
	// Same UID and the right nonce are insufficient if the process is not a descendant.
	attacker := exec.Command(os.Args[0], "-test.run=^TestChild$")
	attacker.Env = append(env, "HOOK_PROOF_ROLE=hook")
	if err = attacker.Start(); err != nil {
		t.Fatal(err)
	}
	_ = l.SetDeadline(time.Now().Add(5 * time.Second))
	conn, err := l.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	err = guard.Accept(conn)
	_ = conn.Close()
	if err == nil {
		t.Fatal("unrelated peer accepted")
	}
	if err = attacker.Wait(); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		request := "send"
		if i == 0 {
			request = "bad"
		}
		_, _ = fmt.Fprintln(in, request)
		_ = l.SetDeadline(time.Now().Add(5 * time.Second))
		c, e := l.AcceptUnix()
		if e != nil {
			t.Fatal(e)
		}
		e = guard.Accept(c)
		_ = c.Close()
		if i == 0 && (e == nil || e.Error() != "receipt mismatch") {
			t.Fatalf("wrong nonce accepted: %v", e)
		}
		if i == 1 && e != nil {
			t.Fatalf("owned child rejected: %v", e)
		}
		if i == 2 && (e == nil || e.Error() != "nonce consumed") {
			t.Fatalf("nonce reuse accepted: %v", e)
		}
		if !scanner.Scan() || scanner.Text() != "done" {
			t.Fatal("owner child did not finish")
		}
	}
}

package main

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestClassify(t *testing.T) {
	for _, tc := range []struct {
		name   string
		in     []string
		rc     bool
		out    []string
		reject bool
	}{
		{"plain", nil, true, []string{"--remote", "unix://"}, false},
		{"prompt", []string{"-m", "gpt-6", "hello"}, true, []string{"--remote", "unix://", "-m", "gpt-6", "hello"}, false},
		{"resume", []string{"resume", "id", "--remote", "unix://"}, true, []string{"--remote", "unix://", "resume", "id"}, false},
		{"foreign after resume", []string{"resume", "id", "--remote", "unix:///tmp/no"}, false, nil, true},
		{"exec", []string{"-m", "gpt-6", "exec", "hello"}, false, nil, true},
		{"server", []string{"app-server"}, false, nil, true},
		{"server flag as value", []string{"app-server", "-c", "--remote-control"}, false, nil, true},
		{"server rc", []string{"app-server", "--remote-control"}, false, nil, true},
		{"login", []string{"login"}, false, []string{"login"}, false},
		{"unknown option", []string{"--bad", "exec"}, false, nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rc, out, err := classify(tc.in)
			if (err != nil) != tc.reject || rc != tc.rc || !reflect.DeepEqual(out, tc.out) {
				t.Fatalf("got %v %#v %v", rc, out, err)
			}
		})
	}
}

// The opt-in agent gate must not expose unobserved foreground servers or
// lifecycle commands that can interrupt other sessions.
func TestRejectUncheckedEntrypoints(t *testing.T) {
	for _, args := range [][]string{
		{"app-server", "--remote-control"},
		{"app-server", "daemon", "start", "--remote-control"},
		{"remote-control", "start", "--json"},
		{"remote-control", "stop"},
		{"agents", "--no-daemon"},
		{"resume", "id", "--no-daemon"},
		{"update"},
		{"app"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			if _, _, err := classify(args); err == nil {
				t.Fatalf("unchecked launch was accepted: %q", args)
			}
		})
	}
}

func TestConnectedSocketAdmission(t *testing.T) {
	// Keep the socket short on macOS; the home may be an arbitrarily long path.
	dir, err := os.MkdirTemp(os.TempDir(), "gate-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	listener, err := net.Listen("unix", filepath.Join(dir, "s"))
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	socket, err := filepath.EvalSymlinks(filepath.Join(dir, "s"))
	if err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(dir, "home")
	if err = os.MkdirAll(filepath.Join(home, "app-server-control"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(socket, filepath.Join(home, "app-server-control", "app-server-control.sock")); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, status, path string
		want               bool
	}{
		{"connected", "connected", socket, true},
		{"disabled", "disabled", socket, false},
		{"connecting", "connecting", socket, false},
		{"wrong socket", "connected", socket + "-other", false},
		{"missing status", "", socket, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payload, _ := json.Marshal(map[string]string{"status": tc.status, "socket_path": tc.path})
			// Shell quoting is confined to this deterministic test executable.
			quoted := "'" + strings.ReplaceAll(string(payload), "'", "'\\''") + "'"
			script := filepath.Join(dir, "checker")
			if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '%s\\n' "+quoted+"\n"), 0700); err != nil {
				t.Fatal(err)
			}
			got, err := readConnectedSocket(script, home)
			if (err == nil) != tc.want {
				t.Fatalf("got %q, %v; allowed=%v", got, err, tc.want)
			}
			if tc.want && got != "unix://"+socket {
				t.Fatalf("unexpected endpoint %q", got)
			}
		})
	}
	if _, err := readConnectedSocket(filepath.Join(dir, "missing-checker"), home); err == nil {
		t.Fatal("missing checker admitted")
	}
	if _, err := readConnectedSocket(filepath.Join(dir, "checker"), "relative-home"); err == nil {
		t.Fatal("relative home admitted")
	}
}

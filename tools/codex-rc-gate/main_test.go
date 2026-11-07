package main

import (
	"reflect"
	"testing"
)

func TestReadOnlyAllowlist(t *testing.T) {
	for _, args := range [][]string{{"--help"}, {"-h"}, {"help"}, {"--version"}, {"-V"}, {"completion", "zsh"}, {"completion", "bash"}} {
		got, err := classify(args)
		if err != nil || !reflect.DeepEqual(got, args) {
			t.Errorf("read-only command refused: %q: %v", args, err)
		}
	}
}

func TestRequireNARForAllAgentStarts(t *testing.T) {
	for _, args := range [][]string{
		nil, {"hello"}, {"-m", "gpt-6", "hello"}, {"resume", "id"}, {"fork", "id"}, {"agents"},
		{"--remote", "unix://"}, {"--", "hello"}, {"future-agent-command"},
		{"app-server", "--remote-control"}, {"app-server", "daemon", "start", "--remote-control"},
		{"remote-control", "start", "--json"}, {"remote-control", "stop"}, {"exec", "hello"}, {"e", "hello"},
		{"review"}, {"exec-server"}, {"sandbox"}, {"debug"}, {"queue"}, {"cloud"}, {"update"}, {"app"},
		{"agents", "--no-daemon"}, {"resume", "id", "--no-daemon"}, {"--help", "exec"},
		{"completion", "zsh", "exec"}, {"completion", "unknown"}, {"mcp"}, {"plugin"}, {"login"}, {"doctor"},
	} {
		if _, err := classify(args); err == nil {
			t.Errorf("native start bypassed NAR: %q", args)
		}
	}
}

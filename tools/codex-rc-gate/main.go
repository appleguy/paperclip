// An opt-in shim: direct paths to Codex bypass this program.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

const binary = "/opt/homebrew/bin/codex"

func classify(args []string) (bool, []string, error) {
	valueFlags := map[string]bool{"-c": true, "--config": true, "-m": true, "--model": true, "--enable": true, "--disable": true, "-C": true, "--cd": true, "--add-dir": true, "-i": true, "--image": true, "--sandbox": true, "-s": true, "--ask-for-approval": true, "-a": true, "--profile": true, "-p": true}
	boolFlags := map[string]bool{"--dangerously-bypass-approvals-and-sandbox": true, "--dangerously-bypass-hook-trust": true, "--full-auto": true, "--search": true, "--no-alt-screen": true, "--oss": true, "--strict-config": true}
	remote := false
	serverRC := false
	command := ""
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			break
		}
		if a == "--remote" || strings.HasPrefix(a, "--remote=") {
			v := strings.TrimPrefix(a, "--remote=")
			if a == "--remote" {
				i++
				if i >= len(args) {
					return false, nil, errors.New("missing remote address")
				}
				v = args[i]
			}
			if v != "unix://" || remote {
				return false, nil, errors.New("only the current home's RC daemon is allowed")
			}
			remote = true
			continue
		}
		if valueFlags[a] {
			i++
			if i >= len(args) {
				return false, nil, errors.New("missing option value")
			}
			continue
		}
		if strings.HasPrefix(a, "-") {
			if command == "app-server" && a == "--remote-control" {
				serverRC = true
			}
			if command == "" && !boolFlags[a] && !strings.HasPrefix(a, "--config=") && !strings.HasPrefix(a, "--model=") {
				return false, nil, errors.New("unsupported option")
			}
			continue
		}
		if command == "" {
			command = a
		}
	}
	switch command {
	case "login", "logout", "completion", "features", "doctor", "mcp", "plugin", "app", "remote-control", "help":
		return false, args, nil
	case "app-server":
		if serverRC {
			return false, args, nil
		}
		return false, nil, errors.New("app-server without --remote-control is forbidden")
	case "exec", "e", "review", "exec-server", "sandbox", "debug", "queue", "cloud":
		return false, nil, errors.New("non-interactive agent execution is forbidden")
	}
	if !remote {
		args = append([]string{"--remote", "unix://"}, args...)
	}
	return true, args, nil
}

func connected() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "remote-control", "start", "--json")
	out, err := cmd.Output()
	if err != nil {
		return false
	}
	var status struct {
		Status string `json:"status"`
	}
	return json.Unmarshal(out, &status) == nil && status.Status == "connected"
}
func main() {
	args := os.Args[1:]
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h" || args[0] == "--version") {
		_ = syscall.Exec(binary, append([]string{binary}, args...), os.Environ())
		fmt.Fprintln(os.Stderr, "codex-rc-gate: cannot execute Homebrew codex")
		os.Exit(1)
	}
	check, out, err := classify(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "codex-rc-gate:", err)
		os.Exit(1)
	}
	if check && !connected() {
		fmt.Fprintln(os.Stderr, "codex-rc-gate: Remote Control is not connected")
		os.Exit(1)
	}
	_ = syscall.Exec(binary, append([]string{binary}, out...), os.Environ())
	fmt.Fprintln(os.Stderr, "codex-rc-gate: cannot execute Homebrew codex")
	os.Exit(1)
}

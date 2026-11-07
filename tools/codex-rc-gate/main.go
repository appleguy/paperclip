// An opt-in agent gate. Direct paths to Homebrew Codex still bypass it.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const binary = "/opt/homebrew/bin/codex"
const checker = "/Volumes/NVM/AI_Agent_Runtime/bin/codex-rc-watch"

func classify(args []string) (bool, []string, error) {
	valueFlags := map[string]bool{"-c": true, "--config": true, "-m": true, "--model": true, "--enable": true, "--disable": true, "-C": true, "--cd": true, "--add-dir": true, "-i": true, "--image": true, "--sandbox": true, "-s": true, "--ask-for-approval": true, "-a": true, "--profile": true, "-p": true}
	boolFlags := map[string]bool{"--dangerously-bypass-approvals-and-sandbox": true, "--dangerously-bypass-hook-trust": true, "--full-auto": true, "--search": true, "--no-alt-screen": true, "--oss": true, "--strict-config": true, "--approve-for-me": true}
	remote := false
	command := ""
	clean := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			clean = append(clean, args[i:]...)
			break
		}
		if a == "--no-daemon" || strings.HasPrefix(a, "--no-daemon=") {
			return false, nil, errors.New("embedded execution is forbidden; use NAR on the connected RC daemon")
		}
		if a == "--remote-auth-token-env" || strings.HasPrefix(a, "--remote-auth-token-env=") {
			return false, nil, errors.New("only the current home's local RC daemon is allowed")
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
		clean = append(clean, a)
		if valueFlags[a] {
			i++
			if i >= len(args) {
				return false, nil, errors.New("missing option value")
			}
			clean = append(clean, args[i])
			continue
		}
		if strings.HasPrefix(a, "-") {
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
	case "login", "logout", "completion", "features", "doctor", "mcp", "plugin", "help":
		return false, args, nil
	case "app-server", "remote-control":
		return false, nil, errors.New("server and lifecycle commands are forbidden through the agent gate; the RC watcher owns recovery")
	case "exec", "e", "review", "exec-server", "sandbox", "debug", "queue", "cloud", "update", "app":
		return false, nil, errors.New("direct agent execution or self-update is forbidden; use NAR and Homebrew")
	}
	return true, append([]string{"--remote", "unix://"}, clean...), nil
}

func readConnectedSocket(checkPath, home string) (string, error) {
	if !filepath.IsAbs(home) {
		return "", errors.New("CODEX_HOME must be absolute")
	}
	home, err := filepath.EvalSymlinks(home)
	if err != nil {
		return "", errors.New("Codex home is unavailable")
	}
	expected, err := filepath.EvalSymlinks(filepath.Join(home, "app-server-control", "app-server-control.sock"))
	if err != nil {
		return "", errors.New("existing RC daemon socket is unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, checkPath, "--check", "--home", home).Output()
	if err != nil {
		return "", errors.New("Remote Control admission check failed")
	}
	var status struct {
		Status     string `json:"status"`
		SocketPath string `json:"socket_path"`
	}
	if json.Unmarshal(out, &status) != nil || status.Status != "connected" || status.SocketPath != expected {
		return "", errors.New("Remote Control is not connected to the expected daemon")
	}
	info, err := os.Stat(expected)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		return "", errors.New("RC daemon socket is unavailable")
	}
	return "unix://" + expected, nil
}

func main() {
	args := os.Args[1:]
	if len(args) == 1 && (args[0] == "--help" || args[0] == "-h" || args[0] == "--version" || args[0] == "-V") {
		_ = syscall.Exec(binary, append([]string{binary}, args...), os.Environ())
		fmt.Fprintln(os.Stderr, "codex-rc-gate: cannot execute Homebrew codex")
		os.Exit(1)
	}
	check, out, err := classify(args)
	if err == nil && check {
		home := os.Getenv("CODEX_HOME")
		if home == "" {
			var userHome string
			userHome, err = os.UserHomeDir()
			home = filepath.Join(userHome, ".codex")
		}
		if err == nil {
			var endpoint string
			endpoint, err = readConnectedSocket(checker, home)
			if err == nil {
				out[1] = endpoint
			}
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "codex-rc-gate:", err)
		os.Exit(1)
	}
	_ = syscall.Exec(binary, append([]string{binary}, out...), os.Environ())
	fmt.Fprintln(os.Stderr, "codex-rc-gate: cannot execute Homebrew codex")
	os.Exit(1)
}

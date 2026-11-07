// Opt-in agent launch gate. Absolute Homebrew and bundled paths remain outside it.
package main

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

const binary = "/opt/homebrew/bin/codex"

func classify(args []string) ([]string, error) {
	if len(args) == 1 {
		switch args[0] {
		case "--help", "-h", "help", "--version", "-V":
			return args, nil
		}
	}
	if len(args) == 2 && args[0] == "completion" {
		switch args[1] {
		case "bash", "elvish", "fish", "powershell", "zsh":
			return args, nil
		}
	}
	return nil, errors.New("native agent and lifecycle starts are forbidden through the agent gate; use NAR on the connected RC daemon")
}

func main() {
	args, err := classify(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "codex-rc-gate:", err)
		os.Exit(1)
	}
	_ = syscall.Exec(binary, append([]string{binary}, args...), os.Environ())
	fmt.Fprintln(os.Stderr, "codex-rc-gate: cannot execute Homebrew codex")
	os.Exit(1)
}

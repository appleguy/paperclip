// daemon-audit reports potential extra Codex app-servers. It never signals processes.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type process struct {
	PID    int    `json:"pid"`
	Action string `json:"action"`
}

// Parse only Codex's app-server subcommand, not the similarly named watcher,
// proxy, or arbitrary commands that happen to mention it as an argument.
func classify(line string, uid int, approvedExecutable string, approvedPID int) (process, bool) {
	fields := strings.Fields(line)
	if len(fields) < 4 {
		return process{}, false
	}
	pid, e := strconv.Atoi(fields[0])
	if e != nil || pid <= 0 {
		return process{}, false
	}
	owner, e := strconv.Atoi(fields[1])
	if e != nil || owner != uid {
		return process{}, false
	}
	executable := fields[2]
	if filepath.Base(executable) != "codex" || fields[3] != "app-server" {
		return process{}, false
	}
	action := "would_terminate"
	if pid == approvedPID && executable == approvedExecutable {
		action = "approved"
	}
	return process{pid, action}, true
}

func run() error {
	if len(os.Args) != 3 {
		return fmt.Errorf("usage: daemon-audit APPROVED_PID APPROVED_EXECUTABLE")
	}
	pid, e := strconv.Atoi(os.Args[1])
	if e != nil || pid <= 0 || !filepath.IsAbs(os.Args[2]) {
		return fmt.Errorf("invalid approved identity")
	}
	output, e := exec.Command("/bin/ps", "-axo", "pid=,uid=,command=").Output()
	if e != nil {
		return e
	}
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	enc := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		if p, ok := classify(scanner.Text(), os.Getuid(), os.Args[2], pid); ok {
			if e = enc.Encode(p); e != nil {
				return e
			}
		}
	}
	return scanner.Err()
}
func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}

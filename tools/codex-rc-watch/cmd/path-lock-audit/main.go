// path-lock-audit is read-only. It reports app-server candidates and the
// observable parent chain; it never sends signals or modifies executables.
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
	PID        int      `json:"pid"`
	PPID       int      `json:"ppid"`
	UID        int      `json:"uid"`
	Executable string   `json:"executable"`
	Args       []string `json:"-"`
}
type event struct {
	Action      string    `json:"action"`
	Process     process   `json:"process"`
	Ancestors   []process `json:"ancestors"`
	ChainStatus string    `json:"chain_status"`
}

func parse(line string) (process, bool) {
	f := strings.Fields(line)
	if len(f) < 4 {
		return process{}, false
	}
	pid, e1 := strconv.Atoi(f[0])
	ppid, e2 := strconv.Atoi(f[1])
	uid, e3 := strconv.Atoi(f[2])
	if e1 != nil || e2 != nil || e3 != nil || pid <= 0 || ppid < 0 || uid < 0 {
		return process{}, false
	}
	return process{PID: pid, PPID: ppid, UID: uid, Executable: f[3], Args: f[4:]}, true
}
func appServer(p process) bool {
	return filepath.Base(p.Executable) == "codex" && len(p.Args) > 0 && p.Args[0] == "app-server" && (len(p.Args) == 1 || p.Args[1] != "daemon")
}
func report(procs map[int]process, uid, approvedPID int, approvedPath string) []event {
	out := []event{}
	for _, p := range procs {
		if p.UID != uid || !appServer(p) {
			continue
		}
		action := "would_terminate"
		if p.PID == approvedPID && p.Executable == approvedPath {
			action = "approved"
		}
		e := event{Action: action, Process: p, Ancestors: []process{}, ChainStatus: "complete"}
		seen := map[int]bool{p.PID: true}
		parent := p.PPID
		for parent > 0 {
			if seen[parent] {
				e.ChainStatus = "cycle"
				break
			}
			seen[parent] = true
			v, ok := procs[parent]
			if !ok {
				e.ChainStatus = "parent_unavailable"
				break
			}
			e.Ancestors = append(e.Ancestors, v)
			if v.PID == 1 {
				e.ChainStatus = "ends_at_launchd"
				break
			}
			parent = v.PPID
		}
		out = append(out, e)
	}
	return out
}
func run() error {
	if len(os.Args) != 3 {
		return fmt.Errorf("usage: path-lock-audit APPROVED_PID APPROVED_EXECUTABLE")
	}
	pid, err := strconv.Atoi(os.Args[1])
	if err != nil || pid <= 0 || !filepath.IsAbs(os.Args[2]) {
		return fmt.Errorf("invalid approved identity")
	}
	b, err := exec.Command("/bin/ps", "-axo", "pid=,ppid=,uid=,command=").Output()
	if err != nil {
		return err
	}
	procs := map[int]process{}
	scan := bufio.NewScanner(strings.NewReader(string(b)))
	scan.Buffer(make([]byte, 4096), 1024*1024)
	for scan.Scan() {
		if p, ok := parse(scan.Text()); ok {
			procs[p.PID] = p
		}
	}
	if err := scan.Err(); err != nil {
		return err
	}
	enc := json.NewEncoder(os.Stdout)
	for _, e := range report(procs, os.Getuid(), pid, os.Args[2]) {
		if err := enc.Encode(e); err != nil {
			return err
		}
	}
	return nil
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

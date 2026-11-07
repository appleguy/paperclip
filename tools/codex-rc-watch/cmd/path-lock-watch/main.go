// path-lock-watch observes Codex app-server processes. Dry-run is the default.
// ps snapshots are inherently racy and cannot catch every short-lived process.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type proc struct {
	PID        int      `json:"pid"`
	PPID       int      `json:"ppid"`
	UID        int      `json:"uid"`
	Start      string   `json:"start"`
	Executable string   `json:"executable"`
	Args       []string `json:"-"`
}
type event struct {
	Time         string `json:"time"`
	Action       string `json:"action"`
	Process      proc   `json:"process"`
	Ancestors    []proc `json:"ancestors"`
	ParentStatus string `json:"parent_status"`
	Error        string `json:"error,omitempty"`
}

func parse(s string) (proc, bool) {
	f := strings.Fields(s)
	if len(f) < 9 {
		return proc{}, false
	}
	pid, e := strconv.Atoi(f[0])
	ppid, e2 := strconv.Atoi(f[1])
	uid, e3 := strconv.Atoi(f[2])
	if e != nil || e2 != nil || e3 != nil || pid <= 0 || ppid < 0 || uid < 0 {
		return proc{}, false
	}
	return proc{pid, ppid, uid, strings.Join(f[3:8], " "), f[8], f[9:]}, true
}
func snapshot() (map[int]proc, error) {
	b, e := exec.Command("/bin/ps", "-axo", "pid=,ppid=,uid=,lstart=,command=").Output()
	if e != nil {
		return nil, e
	}
	m := map[int]proc{}
	s := bufio.NewScanner(strings.NewReader(string(b)))
	s.Buffer(make([]byte, 4096), 1024*1024)
	for s.Scan() {
		if p, ok := parse(s.Text()); ok {
			m[p.PID] = p
		}
	}
	return m, s.Err()
}
func appServer(p proc) bool {
	return filepath.Base(p.Executable) == "codex" && len(p.Args) > 0 && p.Args[0] == "app-server" && (len(p.Args) == 1 || p.Args[1] != "daemon")
}
func under(path, root string) bool {
	rel, e := filepath.Rel(root, path)
	return e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}
func protected(p proc, m map[int]proc, approvedPID int, approvedRoot string) bool {
	seen := map[int]bool{}
	for p.PID > 0 && !seen[p.PID] {
		if p.PID == approvedPID || (filepath.IsAbs(p.Executable) && under(p.Executable, approvedRoot)) {
			return true
		}
		seen[p.PID] = true
		if p.PPID <= 1 {
			return false
		}
		v, ok := m[p.PPID]
		if !ok {
			return true
		}
		p = v
	}
	return true
}
func chain(p proc, m map[int]proc) ([]proc, string) {
	var out []proc
	seen := map[int]bool{p.PID: true}
	for id := p.PPID; id > 0; {
		if seen[id] {
			return out, "cycle"
		}
		seen[id] = true
		a, ok := m[id]
		if !ok {
			return out, "parent_unavailable"
		}
		out = append(out, a)
		if id == 1 {
			return out, "ends_at_launchd"
		}
		id = a.PPID
	}
	return out, "complete"
}
func same(a, b proc) bool {
	return a.PID == b.PID && a.UID == b.UID && a.Start == b.Start && a.Executable == b.Executable && strings.Join(a.Args, "\x00") == strings.Join(b.Args, "\x00")
}

type getSnapshot func() (map[int]proc, error)

func pass(first map[int]proc, uid, approvedPID int, root string, enforce bool, refresh getSnapshot, signal func(int) error, out *json.Encoder) error {
	for _, p := range first {
		if p.UID != uid || !appServer(p) {
			continue
		}
		parents, status := chain(p, first)
		action := "would_terminate"
		if protected(p, first, approvedPID, root) {
			action = "protected"
		}
		if action == "protected" && enforce {
			continue
		}
		ev := event{Time: time.Now().UTC().Format(time.RFC3339Nano), Action: action, Process: p, Ancestors: parents, ParentStatus: status}
		if action == "would_terminate" && enforce {
			fresh, err := refresh()
			if err != nil {
				ev.Action = "skipped"
				ev.Error = "refresh_failed"
			} else if q, ok := fresh[p.PID]; !ok || !same(p, q) || protected(q, fresh, approvedPID, root) {
				ev.Action = "skipped"
				ev.Error = "identity_or_ancestry_changed"
			} else if err = signal(p.PID); err != nil {
				ev.Action = "signal_failed"
				ev.Error = err.Error()
			} else {
				ev.Action = "sent_sigterm"
			}
		}
		if err := out.Encode(ev); err != nil {
			return err
		}
	}
	return nil
}
func run() error {
	pid := flag.Int("approved-pid", 0, "protected daemon PID")
	root := flag.String("approved-root", "", "protected daemon home")
	interval := flag.Duration("interval", time.Second, "poll interval")
	enforce := flag.Bool("enforce", false, "send SIGTERM after rechecking process identity")
	once := flag.Bool("once", false, "exit after one pass")
	flag.Parse()
	if *pid <= 1 || !filepath.IsAbs(*root) || *root == "/" || *interval < 250*time.Millisecond {
		return errors.New("approved-pid, absolute non-root approved-root and interval >=250ms required")
	}
	enc := json.NewEncoder(os.Stdout)
	for {
		m, e := snapshot()
		if e != nil {
			return e
		}
		if e = pass(m, os.Getuid(), *pid, *root, *enforce, snapshot, func(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }, enc); e != nil {
			return e
		}
		if *once {
			return nil
		}
		time.Sleep(*interval)
	}
}
func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}

package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestReportAndRedaction(t *testing.T) {
	lines := []string{"1 0 0 /sbin/launchd", "10 1 501 /zero/bin/codex app-server --managed-daemon", "11 1 501 /home/bin/codex app-server --secret=do-not-log", "12 1 501 /home/bin/codex app-server daemon pid-update-loop", "13 1 502 /home/bin/codex app-server"}
	ps := map[int]process{}
	for _, line := range lines {
		p, ok := parse(line)
		if !ok {
			t.Fatal(line)
		}
		ps[p.PID] = p
	}
	got := report(ps, 501, 10, "/zero/bin/codex")
	if len(got) != 2 {
		t.Fatalf("got %#v", got)
	}
	actions := map[int]string{}
	for _, e := range got {
		actions[e.Process.PID] = e.Action
		if len(e.Ancestors) != 1 || e.Ancestors[0].PID != 1 || e.ChainStatus != "ends_at_launchd" {
			t.Fatalf("chain: %+v", e)
		}
		b, _ := json.Marshal(e)
		if strings.Contains(string(b), "do-not-log") {
			t.Fatal("arguments leaked")
		}
	}
	if actions[10] != "approved" || actions[11] != "would_terminate" {
		t.Fatal(actions)
	}
}
func TestMissingAndCyclicParents(t *testing.T) {
	for _, tc := range []struct {
		parent int
		status string
	}{{99, "parent_unavailable"}, {5, "cycle"}} {
		p := process{PID: 5, PPID: tc.parent, UID: 501, Executable: "/bin/codex", Args: []string{"app-server"}}
		got := report(map[int]process{5: p}, 501, 7, "/zero/codex")
		if len(got) != 1 || got[0].ChainStatus != tc.status {
			t.Fatalf("%+v", got)
		}
	}
}
func TestParseInvalid(t *testing.T) {
	for _, s := range []string{"", "x 1 501 /bin/codex app-server", "0 1 501 /bin/codex"} {
		if _, ok := parse(s); ok {
			t.Fatalf("accepted %q", s)
		}
	}
}

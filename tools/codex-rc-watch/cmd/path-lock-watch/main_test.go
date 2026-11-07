package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestGuardAndRevalidate(t *testing.T) {
	root := "/zero"
	a := proc{10, 1, 501, "start-a", "/zero/bin/codex", []string{"app-server"}}
	b := proc{11, 1, 501, "start-b", "/other/bin/codex", []string{"app-server", "--secret=hidden"}}
	child := proc{12, 10, 501, "start-c", "/other/bin/codex", []string{"app-server"}}
	m := map[int]proc{1: {PID: 1}, 10: a, 11: b, 12: child}
	var buf bytes.Buffer
	var killed []int
	f := func() (map[int]proc, error) { return m, nil }
	err := pass(m, 501, 10, root, true, f, func(i int) error { killed = append(killed, i); return nil }, json.NewEncoder(&buf))
	got := map[int]bool{}
	for _, pid := range killed {
		got[pid] = true
	}
	if err != nil || len(killed) != 2 || !got[11] || !got[12] || got[10] {
		t.Fatalf("%v %v %s", err, killed, buf.String())
	}
	if strings.Contains(buf.String(), "hidden") {
		t.Fatal("argument leaked")
	}
}
func TestChangedIdentityFailsClosed(t *testing.T) {
	p := proc{11, 1, 501, "a", "/tmp/codex", []string{"app-server"}}
	m := map[int]proc{11: p}
	q := p
	q.Start = "b"
	var b bytes.Buffer
	k := false
	err := pass(m, 501, 10, "/zero", true, func() (map[int]proc, error) { return map[int]proc{11: q}, nil }, func(int) error { k = true; return nil }, json.NewEncoder(&b))
	if err != nil || k || !strings.Contains(b.String(), "identity_or_ancestry_changed") {
		t.Fatalf("%v %v %s", err, k, b.String())
	}
}
func TestParse(t *testing.T) {
	p, ok := parse("85406 1 501 Fri Nov 6 21:51:59 2026 /tmp/codex app-server --managed-daemon")
	if !ok || !appServer(p) || p.Start != "Fri Nov 6 21:51:59 2026" {
		t.Fatalf("%+v", p)
	}
}

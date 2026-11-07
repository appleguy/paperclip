package main

import "testing"

func TestClassify(t *testing.T) {
	const approved = "/zero/releases/0.167.0/bin/codex"
	for _, tc := range []struct {
		line   string
		ok     bool
		action string
	}{
		{"61996 501 " + approved + " app-server --managed-daemon", true, "approved"},
		{"61997 501 " + approved + " app-server --managed-daemon", true, "would_terminate"},
		{"61996 501 /other/bin/codex app-server --managed-daemon", true, "would_terminate"},
		{"50 501 /usr/bin/node app-server", false, ""},
		{"51 501 /usr/bin/codex resume app-server", false, ""},
		{"52 502 /usr/bin/codex app-server", false, ""},
		{"bad 501 /usr/bin/codex app-server", false, ""},
	} {
		p, ok := classify(tc.line, 501, approved, 61996)
		if ok != tc.ok || p.Action != tc.action {
			t.Errorf("%q: got %+v %v", tc.line, p, ok)
		}
	}
}

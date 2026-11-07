package main

import (
	"reflect"
	"testing"
)

func TestClassify(t *testing.T) {
	for _, tc := range []struct {
		name   string
		in     []string
		rc     bool
		out    []string
		reject bool
	}{
		{"plain", nil, true, []string{"--remote", "unix://"}, false},
		{"prompt", []string{"-m", "gpt-6", "hello"}, true, []string{"--remote", "unix://", "-m", "gpt-6", "hello"}, false},
		{"resume", []string{"resume", "id", "--remote", "unix://"}, true, []string{"resume", "id", "--remote", "unix://"}, false},
		{"foreign after resume", []string{"resume", "id", "--remote", "unix:///tmp/no"}, false, nil, true},
		{"exec", []string{"-m", "gpt-6", "exec", "hello"}, false, nil, true},
		{"server", []string{"app-server"}, false, nil, true},
		{"server rc", []string{"app-server", "--remote-control"}, false, []string{"app-server", "--remote-control"}, false},
		{"login", []string{"login"}, false, []string{"login"}, false},
		{"unknown option", []string{"--bad", "exec"}, false, nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rc, out, err := classify(tc.in)
			if (err != nil) != tc.reject || rc != tc.rc || !reflect.DeepEqual(out, tc.out) {
				t.Fatalf("got %v %#v %v", rc, out, err)
			}
		})
	}
}

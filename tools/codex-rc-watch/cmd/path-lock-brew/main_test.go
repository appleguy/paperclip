package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTargetAndBusy(t *testing.T) {
	d := t.TempDir()
	root := filepath.Join(d, "cask")
	bin := filepath.Join(root, "1", "bin")
	if e := os.MkdirAll(bin, 0755); e != nil {
		t.Fatal(e)
	}
	p := filepath.Join(bin, "codex")
	os.WriteFile(p, []byte("v1"), 0755)
	link := filepath.Join(d, "codex")
	os.Symlink(p, link)
	v, e := target(link, root)
	if e != nil || v != p {
		t.Fatalf("%s %v", v, e)
	}
	if !brewBusy("/bin/bash -p /opt/homebrew/Library/Homebrew/brew.sh upgrade codex") || brewBusy("/tmp/codex-path-lock-brew --apply") {
		t.Fatal("brew detection")
	}
	outside := filepath.Join(d, "bad")
	os.Remove(link)
	os.Symlink(outside, link)
	if _, e = target(link, root); e == nil {
		t.Fatal("accepted outside link")
	}
}
func TestReapplyAndDeferral(t *testing.T) {
	d := t.TempDir()
	root := filepath.Join(d, "cask")
	bin := filepath.Join(root, "1", "bin")
	os.MkdirAll(bin, 0755)
	p := filepath.Join(bin, "codex")
	os.WriteFile(p, []byte("v1"), 0755)
	link := filepath.Join(d, "link")
	os.Symlink(p, link)
	approved := filepath.Join(d, "approved")
	guard := filepath.Join(d, "guard")
	os.WriteFile(guard, []byte("#!/bin/sh\nexit 0\n"), 0755)
	journal := filepath.Join(d, "journal")
	if e := apply(link, root, approved, guard, journal, func() (bool, error) { return true, nil }); e == nil {
		t.Fatal("brew not deferred")
	}
	if e := apply(link, root, approved, guard, journal, func() (bool, error) { return false, nil }); e != nil {
		t.Fatal(e)
	}
	b, e := os.ReadFile(approved)
	if e != nil || string(b) != "v1" {
		t.Fatalf("%s %v", b, e)
	}
	bin2 := filepath.Join(root, "2", "bin")
	os.MkdirAll(bin2, 0755)
	p2 := filepath.Join(bin2, "codex")
	os.WriteFile(p2, []byte("v2"), 0755)
	os.Remove(link)
	os.Symlink(p2, link)
	if e := apply(link, root, approved, guard, journal, func() (bool, error) { return false, nil }); e != nil {
		t.Fatal(e)
	}
	b, _ = os.ReadFile(approved)
	if string(b) != "v2" {
		t.Fatal(string(b))
	}
}

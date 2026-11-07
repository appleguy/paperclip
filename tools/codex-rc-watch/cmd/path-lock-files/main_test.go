package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func makeBin(t *testing.T, dir string) string {
	t.Helper()
	p := filepath.Join(dir, "release", "bin", "codex")
	if e := os.MkdirAll(filepath.Dir(p), 0755); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(p, []byte("canary"), 0751); e != nil {
		t.Fatal(e)
	}
	return p
}
func mode(t *testing.T, p string) os.FileMode {
	t.Helper()
	s, e := os.Stat(p)
	if e != nil {
		t.Fatal(e)
	}
	return s.Mode().Perm()
}
func TestLockRestoreAndUpgrade(t *testing.T) {
	root := t.TempDir()
	p := makeBin(t, root)
	var output bytes.Buffer
	if e := lock(root, false, nil, json.NewEncoder(&output)); e != nil || mode(t, p) != 0751 {
		t.Fatalf("dry-run %v %o", e, mode(t, p))
	}
	journal := filepath.Join(t.TempDir(), "journal")
	f, e := os.Create(journal)
	if e != nil {
		t.Fatal(e)
	}
	if e = lock(root, true, f, json.NewEncoder(&output)); e != nil {
		t.Fatal(e)
	}
	f.Close()
	if mode(t, p) != 0640 {
		t.Fatalf("mode %o", mode(t, p))
	}
	if e = restore(journal); e != nil || mode(t, p) != 0751 {
		t.Fatalf("restore %v %o", e, mode(t, p))
	}
}
func TestNoSymlinkFollowingAndReplace(t *testing.T) {
	root := t.TempDir()
	outside := makeBin(t, t.TempDir())
	if e := os.Symlink(filepath.Dir(filepath.Dir(outside)), filepath.Join(root, "symlink")); e != nil {
		t.Fatal(e)
	}
	paths, e := selectFiles(root)
	if e != nil || len(paths) != 0 {
		t.Fatalf("%v %v", paths, e)
	}
	p := makeBin(t, root)
	journal := filepath.Join(t.TempDir(), "j")
	f, e := os.Create(journal)
	if e != nil {
		t.Fatal(e)
	}
	if e = lock(root, true, f, json.NewEncoder(&bytes.Buffer{})); e != nil {
		t.Fatal(e)
	}
	f.Close()
	if e = os.Rename(p, p+".old"); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(p, []byte("new"), 0700); e != nil {
		t.Fatal(e)
	}
	if e = restore(journal); e == nil {
		t.Fatal("restored replacement")
	}
	if mode(t, p) != 0700 || mode(t, outside) != 0751 {
		t.Fatal("changed replacement or external target")
	}
}

func TestNewReleaseReapply(t *testing.T) {
	root := t.TempDir()
	first := makeBin(t, root)
	journal, e := os.Create(filepath.Join(t.TempDir(), "journal"))
	if e != nil {
		t.Fatal(e)
	}
	defer journal.Close()
	if e = lock(root, true, journal, json.NewEncoder(&bytes.Buffer{})); e != nil {
		t.Fatal(e)
	}
	next := makeBin(t, filepath.Join(root, "new-version"))
	if mode(t, next) != 0751 {
		t.Fatal("new release was not executable")
	}
	if e = lock(root, true, journal, json.NewEncoder(&bytes.Buffer{})); e != nil {
		t.Fatal(e)
	}
	if mode(t, first) != 0640 || mode(t, next) != 0640 {
		t.Fatal("reapply failed")
	}
}

func TestBackupsAreNonExecutable(t *testing.T) {
	root := t.TempDir()
	p := makeBin(t, root)
	journal, e := os.Create(filepath.Join(t.TempDir(), "journal"))
	if e != nil {
		t.Fatal(e)
	}
	defer journal.Close()
	if e = lock(root, true, journal, json.NewEncoder(&bytes.Buffer{})); e != nil {
		t.Fatal(e)
	}
	backup := p + ".before-20261106-c34"
	b, e := os.ReadFile(backup)
	if e != nil || string(b) != "canary" || mode(t, backup) != 0600 {
		t.Fatalf("backup=%q mode=%o err=%v", b, mode(t, backup), e)
	}
}

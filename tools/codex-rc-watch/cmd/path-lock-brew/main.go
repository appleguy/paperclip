// path-lock-brew maintains a private CLI copy and guards the linked cask binary.
// Homebrew coordination is best-effort: a brew command can start after the check.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

func within(root, p string) bool {
	r, e := filepath.Rel(root, p)
	return e == nil && r != ".." && !strings.HasPrefix(r, ".."+string(os.PathSeparator))
}
func target(link, root string) (string, error) {
	p, e := filepath.EvalSymlinks(link)
	if e != nil {
		return "", e
	}
	p, e = filepath.Abs(p)
	if e != nil {
		return "", e
	}
	r, e := filepath.EvalSymlinks(root)
	if e != nil {
		return "", e
	}
	r, e = filepath.Abs(r)
	if e != nil {
		return "", e
	}
	if !within(r, p) || filepath.Base(p) != "codex" || filepath.Base(filepath.Dir(p)) != "bin" {
		return "", errors.New("link does not resolve to a cask bin/codex")
	}
	return p, nil
}
func brewBusy(ps string) bool {
	for _, line := range strings.Split(ps, "\n") {
		for _, f := range strings.Fields(line) {
			if f == "/opt/homebrew/bin/brew" || f == "/opt/homebrew/Library/Homebrew/brew.sh" || f == "/opt/homebrew/Library/Homebrew/brew.rb" {
				return true
			}
		}
	}
	return false
}
func busy() (bool, error) {
	b, e := exec.Command("/bin/ps", "-axo", "command=").Output()
	if e != nil {
		return false, e
	}
	return brewBusy(string(b)), nil
}
func copyNew(src, dst string, mode os.FileMode) error {
	in, e := os.Open(src)
	if e != nil {
		return e
	}
	defer in.Close()
	out, e := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	defer out.Close()
	if _, e = io.Copy(out, in); e != nil {
		return e
	}
	if e = out.Sync(); e != nil {
		return e
	}
	return out.Chmod(mode)
}
func apply(link, root, approved, guard, journal string, checkBusy func() (bool, error)) error {
	b, e := checkBusy()
	if e != nil {
		return e
	}
	if b {
		return errors.New("brew running; deferred")
	}
	p, e := target(link, root)
	if e != nil {
		return e
	}
	st, e := os.Stat(p)
	if e != nil {
		return e
	}
	if !st.Mode().IsRegular() {
		return errors.New("cask binary not regular")
	}
	if st.Mode().Perm()&0111 == 0 {
		return nil
	}
	tmp := fmt.Sprintf("%s.c34-new-%d", approved, time.Now().UnixNano())
	if e = copyNew(p, tmp, 0600); e != nil {
		return e
	}
	b, e = checkBusy()
	if e != nil {
		return e
	}
	if b {
		return errors.New("brew started during copy; deferred")
	}
	after, e := target(link, root)
	if e != nil || after != p {
		return errors.New("cask link changed during copy; deferred")
	}
	st2, e := os.Stat(p)
	if e != nil || !os.SameFile(st, st2) || st.Size() != st2.Size() || !st.ModTime().Equal(st2.ModTime()) {
		return errors.New("cask binary changed during copy; deferred")
	}
	if _, e = os.Stat(approved); e == nil {
		backup := fmt.Sprintf("%s.before-20261106-c34.%d", approved, time.Now().UnixNano())
		if e = copyNew(approved, backup, 0600); e != nil {
			return e
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	if e = os.Chmod(tmp, 0755); e != nil {
		return e
	}
	if e = os.Rename(tmp, approved); e != nil {
		return e
	}
	release := filepath.Dir(filepath.Dir(p))
	cmd := exec.Command(guard, "--root", release, "--apply", "--append-journal", "--journal", journal)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
func run() error {
	link := flag.String("link", "", "Homebrew codex symlink")
	root := flag.String("cask-root", "", "codex cask root")
	approved := flag.String("approved-copy", "", "approved CLI copy")
	guard := flag.String("guard", "", "path-lock-files executable")
	journal := flag.String("journal", "", "mode journal")
	enforce := flag.Bool("apply", false, "copy and lock after brew exits")
	flag.Parse()
	for _, s := range []string{*link, *root, *approved, *guard, *journal} {
		if !filepath.IsAbs(s) {
			return errors.New("all paths must be absolute")
		}
	}
	if !*enforce {
		p, e := target(*link, *root)
		if e == nil {
			fmt.Printf("would_guard=%s approved_copy=%s\n", p, *approved)
		}
		return e
	}
	return apply(*link, *root, *approved, *guard, *journal, busy)
}
func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}

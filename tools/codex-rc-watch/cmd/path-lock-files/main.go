// path-lock-files removes execute bits from explicitly selected package trees.
// It is not a security boundary against the owning user. Dry-run is the default.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

type record struct {
	Path   string `json:"path"`
	Mode   uint32 `json:"mode"`
	Device uint64 `json:"device"`
	Inode  uint64 `json:"inode"`
}

// selectFiles never follows directory symlinks, including the root itself.
func selectFiles(root string) ([]string, error) {
	if !filepath.IsAbs(root) || root == "/" {
		return nil, errors.New("root must be a non-root absolute path")
	}
	st, err := os.Lstat(root)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("root must be a real directory")
	}
	var paths []string
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if !d.IsDir() && d.Name() == "codex" && filepath.Base(filepath.Dir(p)) == "bin" {
			paths = append(paths, p)
		}
		return nil
	})
	return paths, err
}
func lock(root string, apply bool, journal *os.File, out *json.Encoder) error {
	paths, err := selectFiles(root)
	if err != nil {
		return err
	}
	for _, path := range paths {
		fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return err
		}
		var st syscall.Stat_t
		err = syscall.Fstat(fd, &st)
		if err != nil {
			syscall.Close(fd)
			return err
		}
		if st.Mode&syscall.S_IFMT != syscall.S_IFREG {
			syscall.Close(fd)
			return fmt.Errorf("not a regular file: %s", path)
		}
		mode := uint32(st.Mode) & 07777
		r := record{path, mode, uint64(st.Dev), st.Ino}
		if mode&0111 == 0 {
			syscall.Close(fd)
			continue
		}
		if err = out.Encode(r); err != nil {
			syscall.Close(fd)
			return err
		}
		if apply {
			if journal == nil {
				syscall.Close(fd)
				return errors.New("journal required")
			}
			if err = json.NewEncoder(journal).Encode(r); err == nil {
				err = journal.Sync()
			}
			if err == nil {
				err = syscall.Fchmod(fd, mode&^0111)
			}
			if err != nil {
				syscall.Close(fd)
				return err
			}
		}
		if err = syscall.Close(fd); err != nil {
			return err
		}
	}
	return nil
}
func restore(journal string) error {
	f, err := os.Open(journal)
	if err != nil {
		return err
	}
	defer f.Close()
	dec := json.NewDecoder(f)
	for dec.More() {
		var r record
		if err := dec.Decode(&r); err != nil {
			return err
		}
		if !filepath.IsAbs(r.Path) || strings.Contains(r.Path, "\n") {
			return errors.New("invalid journal path")
		}
		fd, err := syscall.Open(r.Path, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return err
		}
		var st syscall.Stat_t
		err = syscall.Fstat(fd, &st)
		if err == nil && (uint64(st.Dev) != r.Device || st.Ino != r.Inode || st.Mode&syscall.S_IFMT != syscall.S_IFREG) {
			err = fmt.Errorf("file replaced; refusing restore: %s", r.Path)
		}
		if err == nil {
			err = syscall.Fchmod(fd, r.Mode)
		}
		syscall.Close(fd)
		if err != nil {
			return err
		}
	}
	return nil
}
func run() error {
	root := flag.String("root", "", "absolute package tree to inspect")
	apply := flag.Bool("apply", false, "remove execute bits; write-ahead journal required")
	journal := flag.String("journal", "", "new journal file for --apply, or existing journal for --restore")
	rollback := flag.Bool("restore", false, "restore recorded modes, only if inode and device still match")
	flag.Parse()
	if *rollback {
		if *root != "" || *apply || *journal == "" {
			return errors.New("restore requires only --journal")
		}
		return restore(*journal)
	}
	if *root == "" {
		return errors.New("--root required")
	}
	var f *os.File
	if *apply {
		if *journal == "" {
			return errors.New("--apply requires --journal")
		}
		var err error
		f, err = os.OpenFile(*journal, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		defer f.Close()
	} else if *journal != "" {
		return errors.New("--journal requires --apply or --restore")
	}
	return lock(*root, *apply, f, json.NewEncoder(os.Stdout))
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

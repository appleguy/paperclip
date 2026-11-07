package main

import (
	"errors"
	"io"
	"os"
)

// Startup and log-storage failures use a separate 64 KiB sink with one retained
// generation. The launchd stderr path is the same file, covering early failures.
type boundedErrorWriter struct {
	path     string
	fallback io.Writer
}

func (w boundedErrorWriter) Write(b []byte) (int, error) {
	n, err := w.write(b)
	if err != nil {
		return w.fallback.Write(b)
	}
	return n, nil
}

func (w boundedErrorWriter) write(b []byte) (int, error) {
	const maxBytes = 64 << 10
	if len(b) > maxBytes {
		return 0, errors.New("error_message_too_large")
	}
	if info, err := os.Stat(w.path); err == nil {
		if info.Size()+int64(len(b)) > maxBytes {
			if err = os.Remove(w.path + ".1"); err != nil && !errors.Is(err, os.ErrNotExist) {
				return 0, err
			}
			if err = os.Rename(w.path, w.path+".1"); err != nil {
				return 0, err
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return 0, err
	}
	f, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return 0, err
	}
	n, err := f.Write(b)
	closeErr := f.Close()
	if err != nil {
		return n, err
	}
	return n, closeErr
}

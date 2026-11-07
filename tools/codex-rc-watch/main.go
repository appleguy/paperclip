package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type checkResult struct {
	Status     string `json:"status"`
	SocketPath string `json:"socket_path"`
	Error      string `json:"error,omitempty"`
}

type config struct {
	Homes           []string `json:"homes"`
	IntervalSeconds int      `json:"interval_seconds"`
	TimeoutSeconds  int      `json:"timeout_seconds"`
	LogPath         string   `json:"log_path"`
	LogMaxBytes     int64    `json:"log_max_bytes"`
}

func controlPath(home string) (string, error) {
	if !filepath.IsAbs(home) {
		return "", errors.New("invalid_home")
	}
	path, err := filepath.EvalSymlinks(filepath.Join(home, "app-server-control", "app-server-control.sock"))
	if err != nil {
		return "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.Mode()&os.ModeSocket == 0 {
		return "", errors.New("not_socket")
	}
	return path, nil
}

func classify(err error) string {
	if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ECONNREFUSED) {
		return "absent"
	}
	if errors.Is(err, os.ErrPermission) {
		return "permission_denied"
	}
	var nerr net.Error
	if errors.As(err, &nerr) && nerr.Timeout() {
		return "timeout"
	}
	if errors.Is(err, errProtocol) {
		return "protocol_error"
	}
	// Only local, static errors are allowed into diagnostics.
	if err.Error() == "invalid_home" || err.Error() == "not_socket" {
		return err.Error()
	}
	if strings.HasPrefix(err.Error(), "rpc_error_") {
		return err.Error()
	}
	return "connection_error"
}

func check(home string, timeout time.Duration) checkResult {
	result := checkResult{Status: "unavailable"}
	path, err := controlPath(home)
	if err != nil {
		result.Error = classify(err)
		return result
	}
	result.SocketPath = path
	c, err := connectControl(path, timeout)
	if err != nil {
		result.Error = classify(err)
		return result
	}
	defer c.close()
	result.Status, err = c.status()
	if err != nil {
		result.Status = "unavailable"
		result.Error = classify(err)
	}
	return result
}

type observation struct {
	Home   string `json:"home"`
	Event  string `json:"event"`
	Status string `json:"status,omitempty"`
	Error  string `json:"error,omitempty"`
}

func observe(home string, timeout, recoveryWait time.Duration) observation {
	event := observation{Home: home}
	path, err := controlPath(home)
	if err != nil {
		if classify(err) != "absent" {
			event.Event = "check_failed"
			event.Error = classify(err)
		}
		return event
	}
	c, err := connectControl(path, timeout)
	if err != nil {
		if classify(err) != "absent" {
			event.Event = "check_failed"
			event.Error = classify(err)
		}
		return event
	}
	defer c.close()
	status, err := c.status()
	if err != nil {
		event.Event = "check_failed"
		event.Error = classify(err)
		return event
	}
	if status == "connected" {
		return event
	}
	event.Status = status
	event.Event = "rc_" + status
	if status != "disabled" {
		return event
	}
	// Only the exact disabled state permits repair. This connection is never
	// replaced: a daemon restart between status and enable fails this attempt.
	if err = c.enable(); err != nil {
		event.Error = classify(err)
		return event
	}
	deadline := time.Now().Add(recoveryWait)
	for {
		status, err = c.status()
		if err != nil {
			event.Error = classify(err)
			return event
		}
		event.Status = status
		if status == "connected" {
			event.Event = "rc_disabled_repaired"
			return event
		}
		if status != "connecting" || !time.Now().Before(deadline) {
			return event
		}
		time.Sleep(100 * time.Millisecond)
	}
}

type exceptionLog struct {
	path     string
	maxBytes int64
	last     map[string]string
}

func (l *exceptionLog) record(event observation) error {
	if l.last == nil {
		l.last = make(map[string]string)
	}
	if event.Event == "" {
		delete(l.last, event.Home)
		return nil
	}
	key := event.Event + ":" + event.Status + ":" + event.Error
	if l.last[event.Home] == key {
		return nil
	}
	row := struct {
		Time string `json:"time"`
		observation
	}{Time: time.Now().UTC().Format(time.RFC3339), observation: event}
	b, err := json.Marshal(row)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	if info, statErr := os.Stat(l.path); statErr == nil {
		if info.Size()+int64(len(b)) > l.maxBytes {
			if err = os.Remove(l.path + ".1"); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			if err = os.Rename(l.path, l.path+".1"); err != nil {
				return err
			}
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return statErr
	}
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, writeErr := f.Write(b)
	closeErr := f.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	l.last[event.Home] = key
	return nil
}

func readConfig(path string) (config, error) {
	var c config
	f, err := os.Open(path)
	if err != nil {
		return c, err
	}
	defer f.Close()
	decoder := json.NewDecoder(io.LimitReader(f, 1<<20))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&c); err != nil {
		return c, err
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return c, errors.New("invalid_config")
	}
	if len(c.Homes) == 0 || len(c.Homes) > 32 || !filepath.IsAbs(c.LogPath) ||
		c.IntervalSeconds < 1 || c.IntervalSeconds > 3600 ||
		c.TimeoutSeconds < 1 || c.TimeoutSeconds > 30 ||
		c.LogMaxBytes < 4096 || c.LogMaxBytes > 16<<20 {
		return c, errors.New("invalid_config")
	}
	seen := map[string]bool{}
	for _, home := range c.Homes {
		if !filepath.IsAbs(home) || seen[home] {
			return c, errors.New("invalid_home")
		}
		seen[home] = true
	}
	return c, nil
}

func run(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("codex-rc-watch", flag.ContinueOnError)
	flags.SetOutput(stderr)
	checkOnly := flags.Bool("check", false, "read-only connected check; JSON, exit 0 only if connected")
	home := flags.String("home", "", "absolute CODEX_HOME for --check")
	configPath := flags.String("config", "", "watcher config JSON")
	once := flags.Bool("once", false, "run one watcher pass (may enable disabled RC)")
	timeout := flags.Duration("timeout", 3*time.Second, "read-only check RPC timeout")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() != 0 || *timeout < time.Millisecond || *timeout > 30*time.Second {
		fmt.Fprintln(stderr, "codex-rc-watch: invalid_arguments")
		return 2
	}
	if *checkOnly {
		if *home == "" || *configPath != "" || *once {
			fmt.Fprintln(stderr, "codex-rc-watch: invalid_arguments")
			return 2
		}
		result := check(*home, *timeout)
		if json.NewEncoder(stdout).Encode(result) != nil {
			return 1
		}
		if result.Status == "connected" && result.Error == "" {
			return 0
		}
		return 1
	}
	if *configPath == "" || *home != "" {
		fmt.Fprintln(stderr, "codex-rc-watch: invalid_arguments")
		return 2
	}
	// launchd opens stderr before exec; reopen for each write so rotation stays
	// bounded across repeated process starts, including invalid configuration.
	stderr = boundedErrorWriter{path: filepath.Join(filepath.Dir(*configPath), "launchd-errors.log"), fallback: stderr}
	c, err := readConfig(*configPath)
	if err != nil {
		fmt.Fprintln(stderr, "codex-rc-watch: invalid_config")
		return 2
	}
	log := exceptionLog{path: c.LogPath, maxBytes: c.LogMaxBytes}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(stop)
	for {
		for _, home := range c.Homes {
			event := observe(home, time.Duration(c.TimeoutSeconds)*time.Second, 10*time.Second)
			if err = log.record(event); err != nil {
				fmt.Fprintln(stderr, "codex-rc-watch: exception_log_unavailable")
				return 1
			}
		}
		if *once {
			return 0
		}
		select {
		case <-stop:
			return 0
		case <-time.After(time.Duration(c.IntervalSeconds) * time.Second):
		}
	}
}

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }

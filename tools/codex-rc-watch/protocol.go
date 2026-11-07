package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

const maxMessage = 1 << 20

var errProtocol = errors.New("protocol_error")

// wsRPC is deliberately restricted to the control-plane methods below. It never
// spawns a process, starts a thread, or reconnects during an operation.
type wsRPC struct {
	conn    net.Conn
	r       *bufio.Reader
	timeout time.Duration
	nextID  int
}

func connectControl(path string, timeout time.Duration) (*wsRPC, error) {
	conn, err := net.DialTimeout("unix", path, timeout)
	if err != nil {
		return nil, err
	}
	c := &wsRPC{conn: conn, r: bufio.NewReaderSize(conn, 4096), timeout: timeout}
	ok := false
	defer func() {
		if !ok {
			conn.Close()
		}
	}()
	conn.SetDeadline(time.Now().Add(timeout))
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	key := base64.StdEncoding.EncodeToString(nonce[:])
	req, _ := http.NewRequest("GET", "http://localhost/", nil)
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", key)
	if err = req.Write(conn); err != nil {
		return nil, err
	}
	// Bound the HTTP header read independently of the frame size limit.
	header := bytes.Buffer{}
	for header.Len() <= 8192 {
		line, readErr := c.r.ReadSlice('\n')
		if readErr != nil {
			return nil, errProtocol
		}
		header.Write(line)
		if bytes.Equal(line, []byte("\r\n")) {
			break
		}
	}
	if header.Len() > 8192 {
		return nil, errProtocol
	}
	resp, err := http.ReadResponse(bufio.NewReader(bytes.NewReader(header.Bytes())), req)
	if err != nil {
		return nil, errProtocol
	}
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	if resp.StatusCode != 101 ||
		!strings.EqualFold(resp.Header.Get("Upgrade"), "websocket") ||
		!headerToken(resp.Header.Get("Connection"), "upgrade") ||
		resp.Header.Get("Sec-WebSocket-Accept") != base64.StdEncoding.EncodeToString(sum[:]) ||
		resp.Header.Get("Sec-WebSocket-Extensions") != "" {
		return nil, errProtocol
	}
	_, err = c.call("initialize", map[string]any{
		"clientInfo":   map[string]string{"name": "codex_rc_watch", "title": "Codex RC Watch", "version": "1.0.0"},
		"capabilities": map[string]bool{"experimentalApi": true},
	})
	if err != nil {
		return nil, err
	}
	if err = c.sendJSON(map[string]any{"method": "initialized"}); err != nil {
		return nil, err
	}
	ok = true
	return c, nil
}

func headerToken(value, token string) bool {
	for _, part := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

func (c *wsRPC) close() { c.conn.Close() }

func (c *wsRPC) sendJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return errProtocol
	}
	return c.writeFrame(1, b)
}

func (c *wsRPC) writeFrame(op byte, payload []byte) error {
	if len(payload) > maxMessage {
		return errProtocol
	}
	var mask [4]byte
	if _, err := rand.Read(mask[:]); err != nil {
		return err
	}
	frame := []byte{0x80 | op}
	switch {
	case len(payload) < 126:
		frame = append(frame, 0x80|byte(len(payload)))
	case len(payload) <= 65535:
		frame = append(frame, 0x80|126, byte(len(payload)>>8), byte(len(payload)))
	default:
		frame = append(frame, 0x80|127)
		var size [8]byte
		binary.BigEndian.PutUint64(size[:], uint64(len(payload)))
		frame = append(frame, size[:]...)
	}
	frame = append(frame, mask[:]...)
	for i, b := range payload {
		frame = append(frame, b^mask[i%4])
	}
	for len(frame) != 0 {
		n, err := c.conn.Write(frame)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		frame = frame[n:]
	}
	return nil
}

func (c *wsRPC) readText() ([]byte, error) {
	var message []byte
	fragmented := false
	for count := 0; count < 256; count++ {
		var head [2]byte
		if _, err := io.ReadFull(c.r, head[:]); err != nil {
			return nil, err
		}
		fin, op := head[0]&0x80 != 0, head[0]&15
		if head[0]&0x70 != 0 || head[1]&0x80 != 0 {
			return nil, errProtocol
		}
		size := uint64(head[1] & 127)
		if size == 126 {
			var b [2]byte
			if _, err := io.ReadFull(c.r, b[:]); err != nil {
				return nil, err
			}
			size = uint64(binary.BigEndian.Uint16(b[:]))
		} else if size == 127 {
			var b [8]byte
			if _, err := io.ReadFull(c.r, b[:]); err != nil {
				return nil, err
			}
			size = binary.BigEndian.Uint64(b[:])
		}
		if size > maxMessage || (op >= 8 && (!fin || size > 125)) {
			return nil, errProtocol
		}
		payload := make([]byte, int(size))
		if _, err := io.ReadFull(c.r, payload); err != nil {
			return nil, err
		}
		switch op {
		case 8:
			return nil, io.EOF
		case 9:
			if err := c.writeFrame(10, payload); err != nil {
				return nil, err
			}
			continue
		case 10:
			continue
		case 1:
			if fragmented {
				return nil, errProtocol
			}
			fragmented = !fin
		case 0:
			if !fragmented {
				return nil, errProtocol
			}
		default:
			return nil, errProtocol
		}
		if len(message)+len(payload) > maxMessage {
			return nil, errProtocol
		}
		message = append(message, payload...)
		if fin {
			if !utf8.Valid(message) {
				return nil, errProtocol
			}
			return message, nil
		}
	}
	return nil, errProtocol
}

func (c *wsRPC) call(method string, params any) (json.RawMessage, error) {
	switch method {
	case "initialize", "remoteControl/status/read", "remoteControl/enable":
	default:
		return nil, errProtocol
	}
	c.nextID++
	id := c.nextID
	c.conn.SetDeadline(time.Now().Add(c.timeout))
	if err := c.sendJSON(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		return nil, err
	}
	for count := 0; count < 256; count++ {
		b, err := c.readText()
		if err != nil {
			return nil, err
		}
		var envelope struct {
			ID     *int            `json:"id"`
			Method string          `json:"method"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(b, &envelope) != nil {
			return nil, errProtocol
		}
		if envelope.ID == nil && envelope.Method != "" {
			continue
		}
		if envelope.ID == nil || *envelope.ID != id || envelope.Method != "" {
			return nil, errProtocol
		}
		if len(envelope.Error) > 0 && string(envelope.Error) != "null" {
			// Do not expose remote error text, which may contain account data.
			var e struct {
				Code int `json:"code"`
			}
			if json.Unmarshal(envelope.Error, &e) != nil {
				return nil, errProtocol
			}
			return nil, fmt.Errorf("rpc_error_%d", e.Code)
		}
		if len(envelope.Result) == 0 || string(envelope.Result) == "null" {
			return nil, errProtocol
		}
		return envelope.Result, nil
	}
	return nil, errProtocol
}

func (c *wsRPC) status() (string, error) {
	b, err := c.call("remoteControl/status/read", nil)
	if err != nil {
		return "", err
	}
	var result struct {
		Status string `json:"status"`
	}
	if json.Unmarshal(b, &result) != nil {
		return "", errProtocol
	}
	switch result.Status {
	case "disabled", "connecting", "connected", "errored":
		return result.Status, nil
	default:
		return "", errProtocol
	}
}

func (c *wsRPC) enable() error {
	// Ephemeral enables the existing controller without writing daemon settings.
	_, err := c.call("remoteControl/enable", map[string]bool{"ephemeral": true})
	return err
}

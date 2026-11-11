package server_test

import (
	"bufio"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"router/internal/server"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func startProxyServer(t *testing.T) *server.Server {
	t.Helper()
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, rw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n")
		rw.Flush()
		io.Copy(conn, rw)
	}))
	t.Cleanup(backend.Close)

	target, err := url.Parse(backend.URL)
	require.NoError(t, err)
	listener, err := server.Listen("127.0.0.1:0")
	require.NoError(t, err)
	s := server.Start(listener, httputil.NewSingleHostReverseProxy(target), func(err error) {
		t.Errorf("serve failed: %v", err)
	})
	t.Cleanup(func() { s.Close(true) })
	return s
}

func address(s *server.Server) string {
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(s.Port()))
}

type tunnel struct {
	net.Conn
	reader *bufio.Reader
}

func openTunnel(t *testing.T, s *server.Server) *tunnel {
	t.Helper()
	conn, err := net.Dial("tcp", address(s))
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })

	_, err = conn.Write([]byte("GET /tunnel HTTP/1.1\r\nHost: test\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n"))
	require.NoError(t, err)
	tun := &tunnel{Conn: conn, reader: bufio.NewReader(conn)}
	res, err := http.ReadResponse(tun.reader, nil)
	require.NoError(t, err)
	require.Equal(t, http.StatusSwitchingProtocols, res.StatusCode)

	tun.assertEcho(t, "ping")
	return tun
}

func (tun *tunnel) assertEcho(t *testing.T, message string) {
	t.Helper()
	_, err := tun.Write([]byte(message))
	require.NoError(t, err)

	buf := make([]byte, len(message))
	require.NoError(t, tun.SetReadDeadline(time.Now().Add(time.Second)))
	_, err = io.ReadFull(tun.reader, buf)
	require.NoError(t, err)
	assert.Equal(t, message, string(buf))
}

func (tun *tunnel) assertClosedByServer(t *testing.T) {
	t.Helper()
	require.NoError(t, tun.SetReadDeadline(time.Now().Add(time.Second)))
	_, err := tun.reader.ReadByte()
	require.Error(t, err)
	if netErr, ok := errors.AsType[net.Error](err); ok {
		assert.False(t, netErr.Timeout(), "tunnel was not closed by server")
	}
}

func closeAsync(s *server.Server, force bool) <-chan error {
	closed := make(chan error, 1)
	go func() { closed <- s.Close(force) }()
	return closed
}

func requireClosedWithin(t *testing.T, closed <-chan error, timeout time.Duration) {
	t.Helper()
	select {
	case err := <-closed:
		assert.NoError(t, err)
	case <-time.After(timeout):
		t.Fatalf("close did not return within %v", timeout)
	}
}
func TestGracefulCloseWaitsForTunnels(t *testing.T) {
	s := startProxyServer(t)
	tun := openTunnel(t, s)

	closed := closeAsync(s, false)
	select {
	case err := <-closed:
		t.Fatalf("close returned before tunnel ended: %v", err)
	case <-time.After(200 * time.Millisecond):
	}

	tun.assertEcho(t, "still open")
	require.NoError(t, tun.Close())
	requireClosedWithin(t, closed, time.Second)
}

func TestGracefulCloseForcesTunnelsAfterTimeout(t *testing.T) {
	if testing.Short() {
		t.Skip("waits for GracefulCloseTimeout")
	}
	s := startProxyServer(t)
	tun := openTunnel(t, s)

	requireClosedWithin(t, closeAsync(s, false), server.GracefulCloseTimeout+time.Second)
	tun.assertClosedByServer(t)
}

func TestForceCloseClosesTunnels(t *testing.T) {
	s := startProxyServer(t)
	tun := openTunnel(t, s)

	requireClosedWithin(t, closeAsync(s, true), time.Second)
	tun.assertClosedByServer(t)
}

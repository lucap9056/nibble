package engine

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	fakeModeEnv      = "FAKE_ENGINE_MODE"
	fakeBootstrapEnv = "FAKE_ENGINE_BOOTSTRAP"
)

func TestMain(m *testing.M) {
	mode := os.Getenv(fakeModeEnv)
	if mode == "" {
		code := m.Run()
		os.Exit(code)
	}

	reader := bufio.NewReader(os.Stdin)
	line, _ := reader.ReadBytes('\n')
	bootstrapPath := os.Getenv(fakeBootstrapEnv)
	_ = os.WriteFile(bootstrapPath, line, 0o644)

	switch mode {
	case "report":
		var input bootstrap
		_ = json.Unmarshal(line, &input)
		strayReport := `{"type":"received","id":"stray"}`
		receivedReport := fmt.Sprintf(`{"type":"received","id":%q}`, input.Daemon.ID)
		processedReport := fmt.Sprintf(`{"type":"processed","id":%q,"bubbles":[{"name":"alpha","routing":true,"status":"running","runningHash":"abc"},{"name":"beta","snapshotHash":"h1","routing":false,"status":"failed","stage":"resolve","error":{"name":"SnapshotNotFoundError","message":"Snapshot not found: beta@h1"}}],"rejected":[{"index":1,"name":"alpha","reason":"duplicate","error":{"name":"Error","message":"Duplicate bubble name: alpha"}}]}`, input.Daemon.ID)
		reportSocket := input.Daemon.ReportSocket
		for _, body := range []string{strayReport, receivedReport, processedReport} {
			postReport(reportSocket, body)
		}
		_, _ = io.Copy(io.Discard, reader)
		os.Exit(0)
	case "crash":
		os.Exit(3)
	case "hang":
		_, _ = io.Copy(io.Discard, reader)
		time.Sleep(time.Hour)
	default:
		_, _ = io.Copy(io.Discard, reader)
		os.Exit(0)
	}
}

func postReport(socketPath, body string) {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "unix", socketPath)
		},
	}
	client := &http.Client{Transport: transport}
	payload := strings.NewReader(body)
	resp, err := client.Post("http://daemon/reports", "application/json", payload)
	if err == nil {
		_ = resp.Body.Close()
	}
}

func startFake(t *testing.T, mode string, bubbles []Bubble) (*Engine, string) {
	t.Helper()
	// t.TempDir paths embed the test name and can exceed the unix socket path limit.
	dir, err := os.MkdirTemp("", "nbe")
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	bootstrapPath := filepath.Join(dir, "bootstrap.json")
	reportSocket := filepath.Join(dir, "r.sock")
	env := []string{fakeModeEnv + "=" + mode, fakeBootstrapEnv + "=" + bootstrapPath}
	e, err := Start(os.Args[0], env, reportSocket, bubbles)
	require.NoError(t, err)
	return e, bootstrapPath
}

func readBootstrap(t *testing.T, bootstrapPath string) string {
	t.Helper()
	content, err := os.ReadFile(bootstrapPath)
	require.NoError(t, err)
	return string(content)
}

func TestCloseShutsDownGracefully(t *testing.T) {
	ctx := context.Background()
	bubbles := []Bubble{
		{Name: "alpha", SnapshotHash: "abc", Routing: true},
		{Name: "nested/beta"},
	}
	e, bootstrapPath := startFake(t, "graceful", bubbles)

	closeErr := e.Close(ctx)
	require.NoError(t, closeErr)
	exitErr := e.Err()
	assert.NoError(t, exitErr)

	content := readBootstrap(t, bootstrapPath)
	contentBytes := []byte(content)
	var sent bootstrap
	unmarshalErr := json.Unmarshal(contentBytes, &sent)
	require.NoError(t, unmarshalErr)
	assert.NotEmpty(t, sent.Daemon.ID)
	assert.NotEmpty(t, sent.Daemon.ReportSocket)
	assert.Equal(t, bubbles, sent.Bubbles)
}

func TestExitWithoutCloseIsUnexpected(t *testing.T) {
	ctx := context.Background()
	e, _ := startFake(t, "crash", nil)

	receivedErr := e.WaitReceived()
	assert.ErrorIs(t, receivedErr, ErrUnexpectedExit)
	_, processedErr := e.WaitProcessed()
	assert.ErrorIs(t, processedErr, ErrUnexpectedExit)
	exitErr := e.Err()
	assert.ErrorIs(t, exitErr, ErrUnexpectedExit)
	closeErr := e.Close(ctx)
	assert.ErrorIs(t, closeErr, ErrUnexpectedExit)
}

func TestCloseKillsAfterContextDone(t *testing.T) {
	parent := context.Background()
	ctx, cancel := context.WithTimeout(parent, 200*time.Millisecond)
	defer cancel()
	e, _ := startFake(t, "hang", nil)

	closeErr := e.Close(ctx)
	assert.ErrorIs(t, closeErr, context.DeadlineExceeded)
	assert.NotErrorIs(t, closeErr, ErrUnexpectedExit)
	exitErr := e.Err()
	assert.NotErrorIs(t, exitErr, ErrUnexpectedExit)
}

func TestWaitReportsMatchBootstrapID(t *testing.T) {
	ctx := context.Background()
	e, _ := startFake(t, "report", nil)

	receivedErr := e.WaitReceived()
	require.NoError(t, receivedErr)
	result, err := e.WaitProcessed()
	require.NoError(t, err)
	expected := BootstrapResult{
		Bubbles: []AcceptedBubble{
			{Name: "alpha", Routing: true, Status: "running", RunningHash: "abc"},
			{
				Name: "beta", SnapshotHash: "h1", Status: "failed", Stage: "resolve",
				Error: &ReportError{Name: "SnapshotNotFoundError", Message: "Snapshot not found: beta@h1"},
			},
		},
		Rejected: []Rejection{
			{Index: 1, Name: "alpha", Reason: "duplicate", Error: ReportError{Name: "Error", Message: "Duplicate bubble name: alpha"}},
		},
	}
	assert.Equal(t, expected, result)

	closeErr := e.Close(ctx)
	assert.NoError(t, closeErr)
}

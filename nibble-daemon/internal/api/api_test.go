package api

import (
	"context"
	"daemon/internal/engine"
	"daemon/internal/storage"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"
)

const (
	alphaSource  = `{"name":"alpha","entry":"alpha.bubble.ts"}`
	betaSource   = `{"name":"beta","entry":"beta.bubble.ts"}`
	alphaRunning = `{"name":"alpha","route":"/alpha","state":"running","snapshotHash":"h1","createdAt":"2026-11-16T00:00:00.000Z","routing":true,"routed":true}`
	notFound     = `{"error":"not found"}`
)

type fakeEngine struct {
	mu       sync.Mutex
	requests []string
}

func (f *fakeEngine) handler() http.Handler {
	mux := http.NewServeMux()
	reply := func(pattern string, status int, body string) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			requestBody, _ := io.ReadAll(r.Body)
			requestURI := r.URL.RequestURI()
			f.mu.Lock()
			f.requests = append(f.requests, r.Method+" "+requestURI+" "+string(requestBody))
			f.mu.Unlock()

			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_, _ = io.WriteString(w, body)
		})
	}
	reply("GET /sources", http.StatusOK, `{"sources":[`+alphaSource+`,`+betaSource+`]}`)
	reply("GET /sources/alpha", http.StatusOK, alphaSource)
	reply("GET /sources/beta", http.StatusOK, betaSource)
	reply("GET /sources/missing", http.StatusNotFound, notFound)
	reply("GET /bubbles", http.StatusOK, `{"bubbles":[`+alphaRunning+`]}`)
	reply("GET /bubbles/alpha", http.StatusOK, alphaRunning)
	reply("GET /bubbles/beta", http.StatusNotFound, notFound)
	reply("GET /bubbles/missing", http.StatusNotFound, notFound)
	reply("PUT /bubbles/alpha", http.StatusAccepted, alphaRunning)
	reply("DELETE /bubbles/beta", http.StatusNotFound, notFound)
	reply("PUT /bubbles/beta", http.StatusNotFound, notFound)
	reply("GET /snapshots/alpha", http.StatusOK, `{"snapshots":[{"hash":"h1","createdAt":"2026-11-15T00:00:00.000Z"},{"hash":"h2","createdAt":"2026-11-16T00:00:00.000Z"}]}`)
	reply("GET /snapshots/beta", http.StatusOK, `{"snapshots":[{"hash":"b1","createdAt":"2026-11-15T00:00:00.000Z"}]}`)
	reply("GET /snapshots/missing", http.StatusOK, `{"snapshots":[]}`)
	reply("POST /snapshots/alpha", http.StatusCreated, `{"hash":"h3","createdAt":"2026-11-17T00:00:00.000Z"}`)
	reply("DELETE /snapshots/alpha", http.StatusNoContent, "")
	return mux
}

type fixture struct {
	server  *httptest.Server
	engine  *fakeEngine
	storage *storage.Storage
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	dir, err := os.MkdirTemp("", "nibble-api-")
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(dir) })

	databasePath := filepath.Join(dir, "bubbles.db")
	store, err := storage.Open(databasePath)
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })

	fake := &fakeEngine{}
	socketPath := filepath.Join(dir, "engine.sock")
	listener, err := net.Listen("unix", socketPath)
	require.NoError(t, err)
	engineHandler := fake.handler()
	engineServer := &http.Server{Handler: engineHandler}
	go func() { _ = engineServer.Serve(listener) }()
	t.Cleanup(func() { _ = engineServer.Close() })

	control := engine.NewControl(socketPath)
	handler := New(store, control)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return &fixture{server: server, engine: fake, storage: store}
}

func (f *fixture) do(t *testing.T, method, path, body string) (int, map[string]any) {
	t.Helper()
	bodyReader := strings.NewReader(body)
	req, err := http.NewRequest(method, f.server.URL+path, bodyReader)
	require.NoError(t, err)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	var decoded map[string]any
	if len(raw) > 0 {
		decodeErr := json.Unmarshal(raw, &decoded)
		require.NoError(t, decodeErr)
	}
	return resp.StatusCode, decoded
}

func (f *fixture) save(t *testing.T, record storage.Bubble) {
	t.Helper()
	ctx := context.Background()
	_, err := f.storage.SaveBubble(ctx, record)
	require.NoError(t, err)
}

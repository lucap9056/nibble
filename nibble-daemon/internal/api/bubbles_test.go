package api

import (
	"context"
	"daemon/internal/storage"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestListBubblesMergesSourcesRunningAndDesired(t *testing.T) {
	f := newFixture(t)
	f.save(t, storage.Bubble{Name: "alpha", SnapshotHash: "h1", Enabled: true})
	f.save(t, storage.Bubble{Name: "gamma", SnapshotHash: "g1"})

	status, body := f.do(t, http.MethodGet, "/api/bubbles", "")
	require.Equal(t, http.StatusOK, status)

	bubbles := body["bubbles"].([]any)
	require.Len(t, bubbles, 3)
	alpha := bubbles[0].(map[string]any)
	beta := bubbles[1].(map[string]any)
	gamma := bubbles[2].(map[string]any)
	assert.NotNil(t, alpha["source"])
	assert.NotNil(t, alpha["running"])
	assert.NotNil(t, alpha["desired"])
	assert.Equal(t, "beta", beta["name"])
	assert.Nil(t, beta["desired"])
	assert.Equal(t, "gamma", gamma["name"])
	assert.Nil(t, gamma["source"])
}

func TestGetBubbleMarksRunningAndDesiredSnapshots(t *testing.T) {
	f := newFixture(t)
	f.save(t, storage.Bubble{Name: "alpha", SnapshotHash: "h2"})

	status, body := f.do(t, http.MethodGet, "/api/bubbles/alpha", "")
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, []any{
		map[string]any{"hash": "h1", "createdAt": "2026-11-15T00:00:00Z", "running": true, "desired": false},
		map[string]any{"hash": "h2", "createdAt": "2026-11-16T00:00:00Z", "running": false, "desired": true},
	}, body["snapshots"])

	status, _ = f.do(t, http.MethodGet, "/api/bubbles/missing", "")
	assert.Equal(t, http.StatusNotFound, status)
}

func TestSaveWithoutHashBuildsThenRuns(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	status, _ := f.do(t, http.MethodPut, "/api/bubbles/alpha", `{"enabled":true,"routing":true}`)
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, []string{
		"POST /snapshots/alpha ",
		`PUT /bubbles/alpha {"snapshotHash":"h3","routing":true}`,
	}, f.engine.requests[:2])

	record, err := f.storage.GetBubble(ctx, "alpha")
	require.NoError(t, err)
	assert.Equal(t, storage.Bubble{Name: "alpha", SnapshotHash: "h3", Enabled: true, Routing: true}, record)
}

func TestSaveDisabledStopsBubble(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	status, _ := f.do(t, http.MethodPut, "/api/bubbles/beta", `{"snapshotHash":"b1","enabled":false}`)
	require.Equal(t, http.StatusOK, status)
	assert.Contains(t, f.engine.requests, "DELETE /bubbles/beta ")

	record, err := f.storage.GetBubble(ctx, "beta")
	require.NoError(t, err)
	assert.False(t, record.Enabled)
}

func TestSaveUnknownSnapshotIsNotPersisted(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()

	enabledStatus, _ := f.do(t, http.MethodPut, "/api/bubbles/beta", `{"snapshotHash":"nope","enabled":true}`)
	disabledStatus, _ := f.do(t, http.MethodPut, "/api/bubbles/beta", `{"snapshotHash":"nope","enabled":false}`)
	assert.Equal(t, http.StatusNotFound, enabledStatus)
	assert.Equal(t, http.StatusNotFound, disabledStatus)

	records, err := f.storage.ListBubbles(ctx)
	require.NoError(t, err)
	assert.Empty(t, records)
}

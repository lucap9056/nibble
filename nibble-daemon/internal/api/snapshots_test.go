package api

import (
	"daemon/internal/storage"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestDeleteSnapshotGuardsDesiredSnapshot(t *testing.T) {
	f := newFixture(t)
	f.save(t, storage.Bubble{Name: "alpha", SnapshotHash: "h2"})

	desiredStatus, _ := f.do(t, http.MethodDelete, "/api/snapshots/alpha?hash=h2", "")
	assert.Equal(t, http.StatusConflict, desiredStatus)
	assert.Empty(t, f.engine.requests)

	otherStatus, _ := f.do(t, http.MethodDelete, "/api/snapshots/alpha?hash=h1", "")
	assert.Equal(t, http.StatusNoContent, otherStatus)
}

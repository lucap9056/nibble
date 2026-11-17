package api

import (
	"daemon/internal/storage"
	"errors"
	"fmt"
	"net/http"
)

func (a *API) buildSnapshot(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := r.PathValue("name")
	snapshot, err := a.control.BuildSnapshot(ctx, name)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, snapshot)
}

func (a *API) deleteSnapshot(w http.ResponseWriter, r *http.Request) {
	snapshotHash := r.URL.Query().Get("hash")
	if snapshotHash == "" {
		missingErr := errors.New("hash query parameter is required")
		writeError(w, http.StatusBadRequest, missingErr)
		return
	}

	a.writeMu.Lock()
	defer a.writeMu.Unlock()

	ctx := r.Context()
	name := r.PathValue("name")
	record, err := a.storage.GetBubble(ctx, name)
	switch {
	case err == nil && record.SnapshotHash == snapshotHash:
		desiredErr := fmt.Errorf("%w: %s@%s", errSnapshotDesired, name, snapshotHash)
		writeFailure(w, desiredErr)
		return
	case err != nil && !errors.Is(err, storage.ErrNotFound):
		writeFailure(w, err)
		return
	}

	if err := a.control.DeleteSnapshot(ctx, name, snapshotHash); err != nil {
		writeFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

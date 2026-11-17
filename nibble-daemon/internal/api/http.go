package api

import (
	"daemon/internal/engine"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
)

var (
	errBubbleNotFound    = errors.New("bubble not found")
	errSnapshotNotFound  = errors.New("snapshot not found")
	errSnapshotDesired   = errors.New("snapshot is the desired snapshot")
	errInvalidBubbleName = errors.New("invalid bubble name")
)

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		slog.Error("write response failed", "err", err)
	}
}

func writeError(w http.ResponseWriter, status int, err error) {
	message := err.Error()
	writeJSON(w, status, map[string]string{"error": message})
}

func writeFailure(w http.ResponseWriter, err error) {
	var controlErr *engine.ControlError
	status := http.StatusInternalServerError
	switch {
	case errors.As(err, &controlErr):
		status = controlErr.Status
	case errors.Is(err, engine.ErrUnavailable):
		status = http.StatusBadGateway
	case errors.Is(err, errBubbleNotFound), errors.Is(err, errSnapshotNotFound):
		status = http.StatusNotFound
	case errors.Is(err, errSnapshotDesired):
		status = http.StatusConflict
	}
	writeError(w, status, err)
}

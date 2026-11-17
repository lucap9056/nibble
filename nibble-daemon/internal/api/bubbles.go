package api

import (
	"cmp"
	"context"
	"daemon/internal/engine"
	"daemon/internal/storage"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"slices"
	"strings"
	"time"
)

type bubbleView struct {
	Name    string                `json:"name"`
	Source  *engine.Source        `json:"source"`
	Running *engine.RunningBubble `json:"running"`
	Desired *storage.Bubble       `json:"desired"`
}

type snapshotView struct {
	Hash      string    `json:"hash"`
	CreatedAt time.Time `json:"createdAt"`
	Running   bool      `json:"running"`
	Desired   bool      `json:"desired"`
}

type bubbleDetail struct {
	bubbleView
	Snapshots []snapshotView `json:"snapshots"`
}

type desiredInput struct {
	Hash         string `json:"hash"`
	SnapshotHash string `json:"snapshotHash"`
	Enabled      bool   `json:"enabled"`
	Routing      bool   `json:"routing"`
}

func (a *API) viewBubble(ctx context.Context, name string) (*bubbleDetail, error) {
	source, err := a.control.Source(ctx, name)
	if err != nil && !engine.IsNotFound(err) {
		return nil, err
	}
	running, err := a.control.Bubble(ctx, name)
	if err != nil && !engine.IsNotFound(err) {
		return nil, err
	}
	snapshots, err := a.control.Snapshots(ctx, name)
	if err != nil {
		return nil, err
	}

	var desired *storage.Bubble
	record, err := a.storage.GetBubble(ctx, name)
	switch {
	case err == nil:
		desired = &record
	case !errors.Is(err, storage.ErrNotFound):
		return nil, err
	}

	if source == nil && running == nil && desired == nil && len(snapshots) == 0 {
		return nil, fmt.Errorf("%w: %s", errBubbleNotFound, name)
	}

	snapshotViews := make([]snapshotView, 0, len(snapshots))
	for _, snapshot := range snapshots {
		snapshotViews = append(snapshotViews, snapshotView{
			Hash:      snapshot.Hash,
			CreatedAt: snapshot.CreatedAt,
			Running:   running != nil && running.SnapshotHash == snapshot.Hash,
			Desired:   desired != nil && desired.SnapshotHash == snapshot.Hash,
		})
	}
	view := bubbleView{Name: name, Source: source, Running: running, Desired: desired}
	return &bubbleDetail{bubbleView: view, Snapshots: snapshotViews}, nil
}

func (a *API) listBubbles(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	sources, err := a.control.Sources(ctx)
	if err != nil {
		writeFailure(w, err)
		return
	}
	running, err := a.control.Bubbles(ctx)
	if err != nil {
		writeFailure(w, err)
		return
	}
	records, err := a.storage.ListBubbles(ctx)
	if err != nil {
		writeFailure(w, err)
		return
	}

	views := map[string]*bubbleView{}
	viewOf := func(name string) *bubbleView {
		view, ok := views[name]
		if !ok {
			view = &bubbleView{Name: name}
			views[name] = view
		}
		return view
	}
	for i := range sources {
		viewOf(sources[i].Name).Source = &sources[i]
	}
	for i := range running {
		viewOf(running[i].Name).Running = &running[i]
	}
	for i := range records {
		viewOf(records[i].Name).Desired = &records[i]
	}

	unordered := maps.Values(views)
	bubbles := slices.SortedFunc(unordered, func(left, right *bubbleView) int {
		return strings.Compare(left.Name, right.Name)
	})
	writeJSON(w, http.StatusOK, map[string]any{"bubbles": bubbles})
}

func (a *API) getBubble(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := r.PathValue("name")
	detail, err := a.viewBubble(ctx, name)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (a *API) applyDesired(ctx context.Context, name string, input desiredInput) error {
	if input.Enabled {
		_, err := a.control.RunBubble(ctx, name, input.SnapshotHash, input.Routing)
		return err
	}

	snapshots, err := a.control.Snapshots(ctx, name)
	if err != nil {
		return err
	}
	exists := slices.ContainsFunc(snapshots, func(snapshot engine.Snapshot) bool {
		return snapshot.Hash == input.SnapshotHash
	})
	if !exists {
		return fmt.Errorf("%w: %s@%s", errSnapshotNotFound, name, input.SnapshotHash)
	}

	if err := a.control.RemoveBubble(ctx, name); err != nil && !engine.IsNotFound(err) {
		return err
	}
	return nil
}

func (a *API) saveBubble(w http.ResponseWriter, r *http.Request) {
	var input desiredInput
	bodyReader := http.MaxBytesReader(w, r.Body, maxBodyBytes)
	if err := json.NewDecoder(bodyReader).Decode(&input); err != nil {
		inputErr := fmt.Errorf("invalid body: %w", err)
		writeError(w, http.StatusBadRequest, inputErr)
		return
	}
	input.SnapshotHash = cmp.Or(input.SnapshotHash, input.Hash)

	a.writeMu.Lock()
	defer a.writeMu.Unlock()

	ctx := r.Context()
	name := r.PathValue("name")
	if input.SnapshotHash == "" {
		snapshot, err := a.control.BuildSnapshot(ctx, name)
		if err != nil {
			writeFailure(w, err)
			return
		}
		input.SnapshotHash = snapshot.Hash
	}

	if err := a.applyDesired(ctx, name, input); err != nil {
		writeFailure(w, err)
		return
	}

	record := storage.Bubble{
		Name:         name,
		SnapshotHash: input.SnapshotHash,
		Enabled:      input.Enabled,
		Routing:      input.Routing,
	}
	if _, err := a.storage.SaveBubble(ctx, record); err != nil {
		saveErr := fmt.Errorf("applied to engine but desired state not saved: %w", err)
		writeFailure(w, saveErr)
		return
	}

	detail, err := a.viewBubble(ctx, name)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (a *API) restartBubble(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	name := r.PathValue("name")
	running, err := a.control.RestartBubble(ctx, name)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, running)
}

func (a *API) deleteBubble(w http.ResponseWriter, r *http.Request) {
	a.writeMu.Lock()
	defer a.writeMu.Unlock()

	ctx := r.Context()
	name := r.PathValue("name")
	if err := a.control.RemoveBubble(ctx, name); err != nil && !engine.IsNotFound(err) {
		writeFailure(w, err)
		return
	}
	if err := a.storage.DeleteBubble(ctx, name); err != nil && !errors.Is(err, storage.ErrNotFound) {
		writeFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

package engine

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"sync"
)

type ReportError struct {
	Name    string `json:"name"`
	Message string `json:"message"`
}

type AcceptedBubble struct {
	Name         string       `json:"name"`
	SnapshotHash string       `json:"snapshotHash"`
	Routing      bool         `json:"routing"`
	Status       string       `json:"status"`
	RunningHash  string       `json:"runningHash,omitempty"`
	Stage        string       `json:"stage,omitempty"`
	Error        *ReportError `json:"error,omitempty"`
}

type Rejection struct {
	Index  int         `json:"index"`
	Name   string      `json:"name,omitempty"`
	Reason string      `json:"reason"`
	Error  ReportError `json:"error"`
}

type BootstrapResult struct {
	Bubbles  []AcceptedBubble `json:"bubbles"`
	Rejected []Rejection      `json:"rejected"`
}

type report struct {
	BootstrapResult
	Type string `json:"type"`
	ID   string `json:"id"`
}

const maxReportBytes = 1 << 20

type reportReceiver struct {
	id            string
	server        *http.Server
	received      chan struct{}
	receivedOnce  sync.Once
	processed     chan struct{}
	processedOnce sync.Once
	result        BootstrapResult
}

func listenReports(socketPath, id string) (*reportReceiver, error) {
	if err := os.Remove(socketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("failed to remove stale report socket: %w", err)
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return nil, fmt.Errorf("failed to listen report socket: %w", err)
	}

	r := &reportReceiver{
		id:        id,
		received:  make(chan struct{}),
		processed: make(chan struct{}),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /reports", r.accept)
	r.server = &http.Server{Handler: mux}
	go func() { _ = r.server.Serve(listener) }()
	return r, nil
}

func (r *reportReceiver) accept(w http.ResponseWriter, req *http.Request) {
	var input report
	bodyReader := http.MaxBytesReader(w, req.Body, maxReportBytes)
	if err := json.NewDecoder(bodyReader).Decode(&input); err != nil {
		message := fmt.Sprintf("invalid report: %v", err)
		http.Error(w, message, http.StatusBadRequest)
		return
	}
	if input.ID != r.id {
		http.Error(w, "report id mismatch", http.StatusBadRequest)
		return
	}

	switch input.Type {
	case "received":
		r.receivedOnce.Do(func() { close(r.received) })
	case "processed":
		r.processedOnce.Do(func() {
			r.result = input.BootstrapResult
			close(r.processed)
		})
	default:
		message := fmt.Sprintf("unknown report type: %s", input.Type)
		http.Error(w, message, http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (r *reportReceiver) Close() error {
	return r.server.Close()
}

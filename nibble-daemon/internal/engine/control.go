package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

var (
	ErrUnavailable = errors.New("engine unavailable")
	controlURL     = &url.URL{Scheme: "http", Host: "engine", Path: "/"}
)

type ControlError struct {
	Status  int
	Message string
}

func (e *ControlError) Error() string {
	return e.Message
}

func IsNotFound(err error) bool {
	var controlErr *ControlError
	return errors.As(err, &controlErr) && controlErr.Status == http.StatusNotFound
}

type Source struct {
	Name  string `json:"name"`
	Entry string `json:"entry"`
}

type RunningBubble struct {
	Name         string    `json:"name"`
	Route        string    `json:"route"`
	State        string    `json:"state"`
	SnapshotHash string    `json:"snapshotHash"`
	CreatedAt    time.Time `json:"createdAt"`
	Routing      bool      `json:"routing"`
	Routed       bool      `json:"routed"`
}

type Snapshot struct {
	Hash      string    `json:"hash"`
	CreatedAt time.Time `json:"createdAt"`
}

type runRequest struct {
	SnapshotHash string `json:"snapshotHash"`
	Routing      bool   `json:"routing"`
}

type Control struct {
	client *http.Client
}

func NewControl(socketPath string) *Control {
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "unix", socketPath)
		},
	}
	return &Control{client: &http.Client{Transport: transport}}
}

func (c *Control) do(ctx context.Context, method string, endpoint *url.URL, input, output any) error {
	var body io.Reader
	if input != nil {
		payload, err := json.Marshal(input)
		if err != nil {
			return fmt.Errorf("failed to encode request: %w", err)
		}
		body = bytes.NewReader(payload)
	}

	target := endpoint.String()
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= http.StatusBadRequest {
		var failure struct {
			Error string `json:"error"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&failure); err != nil || failure.Error == "" {
			failure.Error = http.StatusText(resp.StatusCode)
		}
		return &ControlError{Status: resp.StatusCode, Message: failure.Error}
	}
	if output == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(output); err != nil {
		return fmt.Errorf("invalid engine response: %w", err)
	}
	return nil
}

func (c *Control) Sources(ctx context.Context) ([]Source, error) {
	var list struct {
		Sources []Source `json:"sources"`
	}
	endpoint := controlURL.JoinPath("sources")
	err := c.do(ctx, http.MethodGet, endpoint, nil, &list)
	return list.Sources, err
}

func (c *Control) Source(ctx context.Context, name string) (*Source, error) {
	var source Source
	endpoint := controlURL.JoinPath("sources", name)
	if err := c.do(ctx, http.MethodGet, endpoint, nil, &source); err != nil {
		return nil, err
	}
	return &source, nil
}

func (c *Control) Bubbles(ctx context.Context) ([]RunningBubble, error) {
	var list struct {
		Bubbles []RunningBubble `json:"bubbles"`
	}
	endpoint := controlURL.JoinPath("bubbles")
	err := c.do(ctx, http.MethodGet, endpoint, nil, &list)
	return list.Bubbles, err
}

func (c *Control) Bubble(ctx context.Context, name string) (*RunningBubble, error) {
	var bubble RunningBubble
	endpoint := controlURL.JoinPath("bubbles", name)
	if err := c.do(ctx, http.MethodGet, endpoint, nil, &bubble); err != nil {
		return nil, err
	}
	return &bubble, nil
}

func (c *Control) RunBubble(ctx context.Context, name, snapshotHash string, routing bool) (*RunningBubble, error) {
	var bubble RunningBubble
	endpoint := controlURL.JoinPath("bubbles", name)
	input := runRequest{SnapshotHash: snapshotHash, Routing: routing}
	if err := c.do(ctx, http.MethodPut, endpoint, input, &bubble); err != nil {
		return nil, err
	}
	return &bubble, nil
}

func (c *Control) RestartBubble(ctx context.Context, name string) (*RunningBubble, error) {
	var bubble RunningBubble
	endpoint := controlURL.JoinPath("bubbles", name)
	if err := c.do(ctx, http.MethodPost, endpoint, nil, &bubble); err != nil {
		return nil, err
	}
	return &bubble, nil
}

func (c *Control) RemoveBubble(ctx context.Context, name string) error {
	endpoint := controlURL.JoinPath("bubbles", name)
	return c.do(ctx, http.MethodDelete, endpoint, nil, nil)
}

func (c *Control) Snapshots(ctx context.Context, name string) ([]Snapshot, error) {
	var list struct {
		Snapshots []Snapshot `json:"snapshots"`
	}
	endpoint := controlURL.JoinPath("snapshots", name)
	err := c.do(ctx, http.MethodGet, endpoint, nil, &list)
	return list.Snapshots, err
}

func (c *Control) BuildSnapshot(ctx context.Context, name string) (*Snapshot, error) {
	var snapshot Snapshot
	endpoint := controlURL.JoinPath("snapshots", name)
	if err := c.do(ctx, http.MethodPost, endpoint, nil, &snapshot); err != nil {
		return nil, err
	}
	return &snapshot, nil
}

func (c *Control) DeleteSnapshot(ctx context.Context, name, snapshotHash string) error {
	endpoint := controlURL.JoinPath("snapshots", name)
	query := url.Values{"hash": {snapshotHash}}
	endpoint.RawQuery = query.Encode()
	return c.do(ctx, http.MethodDelete, endpoint, nil, nil)
}

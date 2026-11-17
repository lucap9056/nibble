package engine

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync/atomic"
)

type Bubble struct {
	Name         string `json:"name"`
	SnapshotHash string `json:"snapshotHash,omitempty"`
	Routing      bool   `json:"routing"`
}

type Daemon struct {
	ID           string `json:"id"`
	ReportSocket string `json:"reportSocket"`
}

type bootstrap struct {
	Daemon  Daemon   `json:"daemon"`
	Bubbles []Bubble `json:"bubbles"`
}

var ErrUnexpectedExit = errors.New("engine exited unexpectedly")

type Engine struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	reports *reportReceiver
	closing atomic.Bool
	exited  chan struct{}
	err     error
}

func Start(binaryPath string, env []string, reportSocket string, bubbles []Bubble) (*Engine, error) {
	if bubbles == nil {
		bubbles = []Bubble{}
	}
	id := rand.Text()
	daemon := Daemon{ID: id, ReportSocket: reportSocket}
	payload, err := json.Marshal(bootstrap{Daemon: daemon, Bubbles: bubbles})
	if err != nil {
		return nil, fmt.Errorf("failed to encode bootstrap: %w", err)
	}

	reports, err := listenReports(reportSocket, id)
	if err != nil {
		return nil, err
	}

	cmd := exec.Command(binaryPath)
	environ := os.Environ()
	cmd.Env = append(environ, env...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		closeErr := reports.Close()
		pipeErr := fmt.Errorf("failed to open engine stdin: %w", err)
		return nil, errors.Join(pipeErr, closeErr)
	}
	if err := cmd.Start(); err != nil {
		closeErr := reports.Close()
		startErr := fmt.Errorf("failed to start engine: %w", err)
		return nil, errors.Join(startErr, closeErr)
	}

	if _, err := stdin.Write(append(payload, '\n')); err != nil {
		writeErr := fmt.Errorf("failed to write bootstrap: %w", err)
		killErr := cmd.Process.Kill()
		waitErr := cmd.Wait()
		closeErr := reports.Close()
		return nil, errors.Join(writeErr, killErr, waitErr, closeErr)
	}

	e := &Engine{cmd: cmd, stdin: stdin, reports: reports, exited: make(chan struct{})}
	go e.wait()
	return e, nil
}

func (e *Engine) wait() {
	err := e.cmd.Wait()
	if !e.closing.Load() {
		err = errors.Join(ErrUnexpectedExit, err)
	}
	e.err = err
	close(e.exited)
}

func (e *Engine) WaitReceived() error {
	select {
	case <-e.reports.received:
		return nil
	case <-e.exited:
		return e.err
	}
}

func (e *Engine) WaitProcessed() (BootstrapResult, error) {
	select {
	case <-e.reports.processed:
		return e.reports.result, nil
	case <-e.exited:
		return BootstrapResult{}, e.err
	}
}

func (e *Engine) Exited() <-chan struct{} {
	return e.exited
}

func (e *Engine) Err() error {
	<-e.exited
	return e.err
}

func (e *Engine) Close(ctx context.Context) error {
	e.closing.Store(true)
	stdinErr := e.stdin.Close()

	select {
	case <-e.exited:
		reportsErr := e.reports.Close()
		return errors.Join(stdinErr, reportsErr, e.err)
	case <-ctx.Done():
		killErr := e.cmd.Process.Kill()
		<-e.exited
		reportsErr := e.reports.Close()
		return errors.Join(ctx.Err(), stdinErr, killErr, reportsErr, e.err)
	}
}

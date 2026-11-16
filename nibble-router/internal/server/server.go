package server

import (
	"context"
	"errors"
	"net"
	"net/http"
	"sync"
	"time"
)

const GracefulCloseTimeout = 5 * time.Second

type Server struct {
	http     *http.Server
	cancel   context.CancelFunc
	handlers sync.WaitGroup
	served   chan struct{}
	port     int
}

func Start(listener net.Listener, handler http.Handler, onServeError func(error)) *Server {

	baseCtx, cancel := context.WithCancel(context.Background())
	s := &Server{cancel: cancel, served: make(chan struct{})}
	if tcpAddr, ok := listener.Addr().(*net.TCPAddr); ok {
		s.port = tcpAddr.Port
	}
	s.http = &http.Server{
		BaseContext: func(net.Listener) context.Context { return baseCtx },
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			s.handlers.Add(1)
			defer s.handlers.Done()
			handler.ServeHTTP(w, r)
		}),
	}

	go func() {
		defer close(s.served)
		err := s.http.Serve(listener)
		if !errors.Is(err, http.ErrServerClosed) {
			onServeError(err)
		}
	}()

	return s
}

func (s *Server) Port() int {
	return s.port
}

func (s *Server) Close(force bool) error {
	if force {
		return s.forceClose()
	}

	ctx, cancel := context.WithTimeout(context.Background(), GracefulCloseTimeout)
	defer cancel()

	err := s.http.Shutdown(ctx)
	if err == nil {
		err = waitContext(ctx, s.handlers.Wait)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return s.forceClose()
	}
	s.cancel()
	<-s.served
	return err
}

func (s *Server) forceClose() error {
	err := s.http.Close()
	s.cancel()
	<-s.served
	return err
}

func waitContext(ctx context.Context, wait func()) error {
	done := make(chan struct{})
	go func() {
		wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

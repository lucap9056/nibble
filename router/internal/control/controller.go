package control

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"net"
	"router/internal/proxy"
	"router/internal/routerpb"
	"router/internal/server"
	"sync"

	"google.golang.org/protobuf/encoding/protodelim"
)

var (
	ErrAlreadyRunning       = errors.New("Router is already running")
	ErrNotRunning           = errors.New("Router is not running")
	ErrUnknownCommand       = errors.New("Unknown control command")
	ErrMissingListenAddress = errors.New("Listen address is required")
)

type Controller struct {
	mu           sync.Mutex
	manager      *proxy.Manager
	server       *server.Server
	onServeError func(error)
}

func NewController(onServeError func(error)) *Controller {
	return &Controller{onServeError: onServeError}
}

func (c *Controller) Serve(in io.Reader, out io.Writer) error {
	reader := bufio.NewReader(in)
	for {
		msg := &routerpb.ControlMessage{}
		if err := protodelim.UnmarshalFrom(reader, msg); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("invalid control message: %w", err)
		}
		if _, err := protodelim.MarshalTo(out, c.handle(msg)); err != nil {
			return fmt.Errorf("failed to write result: %w", err)
		}
	}
}

func (c *Controller) handle(msg *routerpb.ControlMessage) *routerpb.ResultMessage {
	switch command := msg.GetCommand().(type) {
	case *routerpb.ControlMessage_Startup:
		return c.handleStartup(msg.GetId(), command.Startup)
	case *routerpb.ControlMessage_SetRoutes:
		return c.handleSetRoutes(msg.GetId(), command.SetRoutes)
	case *routerpb.ControlMessage_Close:
		return c.handleClose(msg.GetId(), command.Close)
	default:
		return newFailureResult(msg.GetId(), ErrUnknownCommand)
	}
}

func (c *Controller) handleStartup(id string, command *routerpb.StartupCommand) *routerpb.ResultMessage {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.server != nil {
		return newFailureResult(id, ErrAlreadyRunning)
	}

	manager := proxy.NewManager()
	if err := manager.SetRoutes(toRouteEntries(command.GetRoutes())); err != nil {
		return newFailureResult(id, err)
	}

	listener, err := listen(command.GetListen())
	if err != nil {
		return newFailureResult(id, err)
	}

	c.manager = manager
	c.server = server.Start(listener, manager, c.onServeError)
	if _, isTCP := listener.Addr().(*net.TCPAddr); isTCP {
		return newPortResult(id, c.server.Port())
	}
	return newSuccessResult(id)
}

func listen(addr string) (net.Listener, error) {
	if addr == "" {
		return nil, ErrMissingListenAddress
	}
	return server.Listen(addr)
}

func (c *Controller) handleSetRoutes(id string, command *routerpb.SetRoutesCommand) *routerpb.ResultMessage {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.manager == nil {
		return newFailureResult(id, ErrNotRunning)
	}
	if err := c.manager.SetRoutes(toRouteEntries(command.GetRoutes())); err != nil {
		return newFailureResult(id, err)
	}
	return newSuccessResult(id)
}

func (c *Controller) handleClose(id string, command *routerpb.CloseCommand) *routerpb.ResultMessage {
	if err := c.Close(command.GetForce()); err != nil {
		return newFailureResult(id, err)
	}
	return newSuccessResult(id)
}

func (c *Controller) Close(force bool) error {
	c.mu.Lock()
	s := c.server
	c.server = nil
	c.manager = nil
	c.mu.Unlock()

	if s == nil {
		return nil
	}
	return s.Close(force)
}

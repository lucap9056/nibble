package main

import (
	"log/slog"
	"os"
	"router/internal/control"
	"strings"

	"github.com/lucap9056/go-lifecycle/v2/lifecycle"
	"github.com/lucap9056/go-lifecycle/v2/runner"
)

func parseLogLevel(value string) slog.Level {
	var level slog.Level
	if err := level.UnmarshalText([]byte(strings.ToUpper(value))); err != nil {
		return slog.LevelInfo
	}
	return level
}

const logTimeLayout = "2006-01-02T15:04:05.000Z07:00"

func replaceLogAttr(_ []string, attr slog.Attr) slog.Attr {
	if attr.Key == slog.TimeKey {
		return slog.String(slog.TimeKey, attr.Value.Time().UTC().Format(logTimeLayout))
	}
	if err, ok := attr.Value.Any().(error); ok {
		return slog.Group(attr.Key, slog.String("message", err.Error()))
	}
	return attr
}

func main() {
	handlerOptions := &slog.HandlerOptions{
		Level:       parseLogLevel(os.Getenv("LOG_LEVEL")),
		ReplaceAttr: replaceLogAttr,
	}
	handler := slog.NewJSONHandler(os.Stderr, handlerOptions)
	slog.SetDefault(slog.New(handler).With("source", "router"))

	if err := runner.Run(run); err != nil {
		slog.Error("router failed", "err", err)
		os.Exit(1)
	}
}

func run(lc *lifecycle.Coordinator) error {
	controller := control.NewController(func(err error) {
		slog.Error("serve failed", "err", err)
		lc.Exit()
	})
	lc.OnExit(func() {
		if err := controller.Close(true); err != nil {
			slog.Error("close failed", "err", err)
		}
	})

	go func() {
		if err := controller.Serve(os.Stdin, os.Stdout); err != nil {
			slog.Error("control channel failed", "err", err)
		}
		lc.Exit()
	}()

	return nil
}

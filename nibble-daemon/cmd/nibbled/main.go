package main

import (
	"context"
	"daemon/internal/api"
	"daemon/internal/auth"
	"daemon/internal/config"
	"daemon/internal/engine"
	"daemon/internal/install"
	"daemon/internal/privilege"
	"daemon/internal/storage"
	"daemon/web"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/lucap9056/go-lifecycle/v2/lifecycle"
	"github.com/lucap9056/go-lifecycle/v2/runner"
)

func parseLogLevel(value string) slog.Level {
	var level slog.Level
	levelText := strings.ToUpper(value)
	if err := level.UnmarshalText([]byte(levelText)); err != nil {
		return slog.LevelInfo
	}
	return level
}

const logTimeLayout = "2006-01-02T15:04:05.000Z07:00"

func replaceLogAttr(_ []string, attr slog.Attr) slog.Attr {
	if attr.Key == slog.TimeKey {
		timestamp := attr.Value.Time().UTC().Format(logTimeLayout)
		return slog.String(slog.TimeKey, timestamp)
	}
	if err, ok := attr.Value.Any().(error); ok {
		message := err.Error()
		messageAttr := slog.String("message", message)
		return slog.Group(attr.Key, messageAttr)
	}
	return attr
}

func main() {
	levelEnv := os.Getenv("LOG_LEVEL")
	level := parseLogLevel(levelEnv)
	handlerOptions := &slog.HandlerOptions{
		Level:       level,
		ReplaceAttr: replaceLogAttr,
	}
	handler := slog.NewJSONHandler(os.Stderr, handlerOptions)
	logger := slog.New(handler).With("source", "daemon")
	slog.SetDefault(logger)

	if len(os.Args) > 1 && (os.Args[1] == "i" || os.Args[1] == "install") {
		os.Exit(runInstall(os.Args[2:]))
	}

	if err := runner.Run(run); err != nil {
		slog.Error("daemon failed", "err", err)
		os.Exit(1)
	}
}

func runInstall(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: nibbled install <path relative to BUBBLE_SOURCE_DIR> [bun install args...]")
		return 2
	}
	paths, err := config.EnginePathsFromEnv()
	if err != nil {
		slog.Error("install failed", "err", err)
		return 1
	}
	if err := privilege.Drop(paths.BubbleSourceDir, privilege.Ownership{}); err != nil {
		slog.Error("install failed", "err", err)
		return 1
	}
	dir, err := install.ResolveTarget(paths.BubbleSourceDir, args[0])
	if err != nil {
		slog.Error("install failed", "err", err)
		return 1
	}

	err = install.Run(paths.BinaryPath, dir, args[1:])
	if exitErr, ok := errors.AsType[*exec.ExitError](err); ok {
		return exitErr.ExitCode()
	}
	if err != nil {
		slog.Error("install failed", "err", err)
		return 1
	}
	return 0
}

const (
	adminShutdownTimeout   = 10 * time.Second
	adminReadHeaderTimeout = 10 * time.Second
	engineShutdownTimeout  = 30 * time.Second
)

func readDesiredBubbles() ([]storage.Bubble, error) {
	info, err := os.Stdin.Stat()
	if err != nil {
		return nil, fmt.Errorf("failed to inspect stdin: %w", err)
	}
	if info.Mode()&os.ModeCharDevice != 0 {
		return nil, nil
	}
	return config.LoadBubbles(os.Stdin)
}

func run(lc *lifecycle.Coordinator) error {
	cfg, err := config.FromEnv()
	if err != nil {
		return err
	}
	enginePaths, err := config.EnginePathsFromEnv()
	if err != nil {
		return err
	}
	owned := privilege.Ownership{
		Dirs: []string{
			filepath.Dir(cfg.DatabasePath),
			filepath.Dir(cfg.PasswordFile),
			filepath.Dir(cfg.JWTSecretFile),
			filepath.Dir(cfg.ReportSocket),
			filepath.Dir(cfg.ControlSocket),
		},
		Files: []string{
			cfg.DatabasePath,
			cfg.DatabasePath + "-wal",
			cfg.DatabasePath + "-shm",
			cfg.PasswordFile,
			cfg.JWTSecretFile,
		},
		Trees: []string{enginePaths.BubbleSnapshotDir, enginePaths.BubbleSocketDir},
	}
	if err := privilege.Drop(enginePaths.BubbleSourceDir, owned); err != nil {
		return err
	}

	secret, err := auth.LoadSecret(cfg.JWTSecretFile)
	if err != nil {
		return err
	}
	credentials, err := auth.LoadCredentials(cfg.PasswordFile, secret, cfg.InitialPassword)
	if err != nil {
		return err
	}
	desiredBubbles, err := readDesiredBubbles()
	if err != nil {
		return err
	}

	store, err := storage.Open(cfg.DatabasePath)
	if err != nil {
		return err
	}
	lc.OnExit(func() {
		if err := store.Close(); err != nil {
			slog.Error("storage close failed", "err", err)
		}
	})

	ctx := context.Background()
	bootstrapRecords := desiredBubbles
	if desiredBubbles == nil {
		records, err := store.ListBubbles(ctx)
		if err != nil {
			return err
		}
		for _, record := range records {
			if record.Enabled {
				bootstrapRecords = append(bootstrapRecords, record)
			}
		}
	}
	bootstrap := []engine.Bubble{}
	for _, record := range bootstrapRecords {
		bootstrap = append(bootstrap, engine.Bubble{
			Name:         record.Name,
			SnapshotHash: record.SnapshotHash,
			Routing:      record.Routing,
		})
	}

	engineEnv := []string{"CONTROL_SOCKET=" + cfg.ControlSocket}
	engineProcess, err := engine.Start(cfg.EngineBinaryPath, engineEnv, cfg.ReportSocket, bootstrap)
	if err != nil {
		return err
	}
	lc.OnExit(func() {
		closeCtx, cancel := context.WithTimeout(ctx, engineShutdownTimeout)
		defer cancel()
		if err := engineProcess.Close(closeCtx); err != nil {
			slog.Error("engine close failed", "err", err)
		}
	})
	go func() {
		<-engineProcess.Exited()
		if err := engineProcess.Err(); errors.Is(err, engine.ErrUnexpectedExit) {
			slog.Error("engine failed", "err", err)
			lc.Exit()
		}
	}()

	if err := engineProcess.WaitReceived(); err != nil {
		return fmt.Errorf("engine did not receive bootstrap: %w", err)
	}
	slog.Info("engine received bootstrap", "bubbles", len(bootstrap))
	result, err := engineProcess.WaitProcessed()
	if err != nil {
		return fmt.Errorf("engine did not process bootstrap: %w", err)
	}
	for _, rejection := range result.Rejected {
		slog.Warn("bootstrap bubble rejected",
			"index", rejection.Index,
			"bubble", rejection.Name,
			"reason", rejection.Reason,
			"error", rejection.Error.Message,
		)
	}
	accepted := []storage.Bubble{}
	for _, bubble := range result.Bubbles {
		if bubble.Error != nil {
			slog.Warn("bootstrap bubble failed",
				"bubble", bubble.Name,
				"stage", bubble.Stage,
				"error", bubble.Error.Message,
			)
		}
		accepted = append(accepted, storage.Bubble{
			Name:         bubble.Name,
			SnapshotHash: bubble.SnapshotHash,
			Enabled:      true,
			Routing:      bubble.Routing,
		})
	}

	if desiredBubbles != nil {
		if err := store.ReplaceBubbles(ctx, accepted); err != nil {
			return err
		}
		slog.Info("desired state replaced from stdin", "bubbles", len(accepted))
	} else {
		for _, rejection := range result.Rejected {
			if rejection.Index < 0 || rejection.Index >= len(bootstrapRecords) {
				return fmt.Errorf("engine rejected unknown bootstrap index %d", rejection.Index)
			}
			record := bootstrapRecords[rejection.Index]
			record.Enabled = false
			if _, err := store.SaveBubble(ctx, record); err != nil {
				return err
			}
			slog.Info("rejected bubble disabled", "bubble", record.Name, "reason", rejection.Reason)
		}
	}

	listener, err := net.Listen("tcp", cfg.AdminListen)
	if err != nil {
		return fmt.Errorf("failed to listen admin: %w", err)
	}
	control := engine.NewControl(cfg.ControlSocket)
	apiHandler := api.New(store, control)
	protectedHandler := auth.RequireToken(credentials, apiHandler)
	authHandler := auth.NewHandler(credentials, protectedHandler)
	jsonHandler := auth.RequireJSON(authHandler)
	webHandler := web.Handler()
	adminMux := http.NewServeMux()
	adminMux.Handle("GET /{$}", webHandler)
	adminMux.Handle("/api/", jsonHandler)
	handler := auth.RequireOrigin(cfg.AdminPublicURL, adminMux)
	server := &http.Server{Handler: handler, ReadHeaderTimeout: adminReadHeaderTimeout}
	lc.OnExit(func() {
		shutdownCtx, cancel := context.WithTimeout(ctx, adminShutdownTimeout)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			slog.Error("admin shutdown failed", "err", err)
		}
	})
	go func() {
		if err := server.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
			slog.Error("admin serve failed", "err", err)
			lc.Exit()
		}
	}()

	slog.Info("daemon started", "admin", cfg.AdminListen, "bubbles", len(bootstrap))
	return nil
}

package config

import (
	"cmp"
	"daemon/internal/storage"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

type seedBubble struct {
	Name         string `json:"name"`
	Hash         string `json:"hash"`
	SnapshotHash string `json:"snapshotHash"`
	Routing      bool   `json:"routing"`
}

type Config struct {
	AdminListen      string
	DatabasePath     string
	EngineBinaryPath string
	ControlSocket    string
	ReportSocket     string
}

func envOr(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}

func FromEnv() (Config, error) {
	executablePath, err := os.Executable()
	if err != nil {
		return Config{}, fmt.Errorf("failed to locate executable: %w", err)
	}
	rootDir := filepath.Dir(executablePath)
	engineBinaryName := "nibble"
	if runtime.GOOS == "windows" {
		engineBinaryName += ".exe"
	}

	defaultDatabasePath := filepath.Join(rootDir, "nibble.db")
	defaultEngineBinaryPath := filepath.Join(rootDir, engineBinaryName)
	defaultReportSocket := filepath.Join(rootDir, "nibbled.sock")
	c := Config{
		AdminListen:      envOr("ADMIN_LISTEN", "127.0.0.1:8081"),
		DatabasePath:     envOr("DATABASE_PATH", defaultDatabasePath),
		EngineBinaryPath: envOr("ENGINE_BINARY", defaultEngineBinaryPath),
		ReportSocket:     envOr("REPORT_SOCKET", defaultReportSocket),
	}
	// Mirrors the engine's own default, which places the socket next to its executable.
	engineDir := filepath.Dir(c.EngineBinaryPath)
	defaultControlSocket := filepath.Join(engineDir, "nibble.sock")
	c.ControlSocket = envOr("CONTROL_SOCKET", defaultControlSocket)

	paths := []*string{&c.DatabasePath, &c.EngineBinaryPath, &c.ControlSocket, &c.ReportSocket}
	for _, path := range paths {
		absolutePath, err := filepath.Abs(*path)
		if err != nil {
			return Config{}, fmt.Errorf("failed to resolve %s: %w", *path, err)
		}
		*path = absolutePath
	}
	return c, nil
}

func LoadBubbles(r io.Reader) ([]storage.Bubble, error) {
	var seeds []seedBubble
	decoder := json.NewDecoder(r)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&seeds); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, nil
		}
		return nil, fmt.Errorf("invalid bubbles: %w", err)
	}

	bubbles := make([]storage.Bubble, 0, len(seeds))
	for i, seed := range seeds {
		if seed.Name == "" {
			return nil, fmt.Errorf("invalid bubbles: [%d] requires name", i)
		}
		snapshotHash := cmp.Or(seed.SnapshotHash, seed.Hash)
		bubbles = append(bubbles, storage.Bubble{
			Name:         seed.Name,
			SnapshotHash: snapshotHash,
			Enabled:      true,
			Routing:      seed.Routing,
		})
	}
	return bubbles, nil
}

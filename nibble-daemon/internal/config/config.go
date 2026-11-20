package config

import (
	"cmp"
	"daemon/internal/storage"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
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
	JWTSecretFile    string
	PasswordFile     string
	InitialPassword  string
	AdminPublicURL   *url.URL
}

func envOr(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}

func engineBinaryPathIn(rootDir string) string {
	engineBinaryName := "nibble"
	if runtime.GOOS == "windows" {
		engineBinaryName += ".exe"
	}
	return filepath.Join(rootDir, engineBinaryName)
}

type EnginePaths struct {
	BinaryPath        string
	BubbleSourceDir   string
	BubbleSnapshotDir string
	BubbleSocketDir   string
}

func EnginePathsFromEnv() (EnginePaths, error) {
	executablePath, err := os.Executable()
	if err != nil {
		return EnginePaths{}, fmt.Errorf("failed to locate executable: %w", err)
	}
	rootDir := filepath.Dir(executablePath)

	binaryPath, err := filepath.Abs(envOr("ENGINE_BINARY", engineBinaryPathIn(rootDir)))
	if err != nil {
		return EnginePaths{}, fmt.Errorf("failed to resolve engine binary: %w", err)
	}
	p := EnginePaths{BinaryPath: binaryPath}

	// Mirrors the engine's own defaults, which place these dirs next to its executable.
	engineDir := filepath.Dir(binaryPath)
	engineDirs := []struct {
		target *string
		key    string
		name   string
	}{
		{&p.BubbleSourceDir, "BUBBLE_SOURCE_DIR", "bubbles"},
		{&p.BubbleSnapshotDir, "BUBBLE_SNAPSHOT_DIR", "snapshots"},
		{&p.BubbleSocketDir, "BUBBLE_SOCKET_DIR", "sockets"},
	}
	for _, dir := range engineDirs {
		defaultDir := filepath.Join(engineDir, dir.name)
		absoluteDir, err := filepath.Abs(envOr(dir.key, defaultDir))
		if err != nil {
			return EnginePaths{}, fmt.Errorf("failed to resolve %s: %w", dir.key, err)
		}
		*dir.target = absoluteDir
	}
	return p, nil
}

func FromEnv() (Config, error) {
	executablePath, err := os.Executable()
	if err != nil {
		return Config{}, fmt.Errorf("failed to locate executable: %w", err)
	}
	rootDir := filepath.Dir(executablePath)

	defaultDatabasePath := filepath.Join(rootDir, "nibble.db")
	defaultEngineBinaryPath := engineBinaryPathIn(rootDir)
	defaultReportSocket := filepath.Join(rootDir, "nibbled.sock")
	defaultJWTSecretFile := filepath.Join(rootDir, "nibbled.key")
	defaultPasswordFile := filepath.Join(rootDir, "nibbled.passwd")
	c := Config{
		AdminListen:      envOr("ADMIN_LISTEN", "127.0.0.1:8081"),
		DatabasePath:     envOr("DATABASE_PATH", defaultDatabasePath),
		EngineBinaryPath: envOr("ENGINE_BINARY", defaultEngineBinaryPath),
		ReportSocket:     envOr("REPORT_SOCKET", defaultReportSocket),
		JWTSecretFile:    envOr("ADMIN_JWT_SECRET_FILE", defaultJWTSecretFile),
		PasswordFile:     envOr("ADMIN_PASSWORD_FILE", defaultPasswordFile),
		InitialPassword:  envOr("ADMIN_INITIAL_PASSWORD", "admin"),
	}
	if publicURLText := os.Getenv("ADMIN_PUBLIC_URL"); publicURLText != "" {
		publicURL, err := url.Parse(publicURLText)
		if err != nil || publicURL.Scheme == "" || publicURL.Host == "" {
			return Config{}, fmt.Errorf("ADMIN_PUBLIC_URL must be an absolute url: %s", publicURLText)
		}
		c.AdminPublicURL = publicURL
	}
	// Mirrors the engine's own default, which places the socket next to its executable.
	engineDir := filepath.Dir(c.EngineBinaryPath)
	defaultControlSocket := filepath.Join(engineDir, "nibble.sock")
	c.ControlSocket = envOr("CONTROL_SOCKET", defaultControlSocket)

	paths := []*string{&c.DatabasePath, &c.EngineBinaryPath, &c.ControlSocket, &c.ReportSocket, &c.JWTSecretFile, &c.PasswordFile}
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

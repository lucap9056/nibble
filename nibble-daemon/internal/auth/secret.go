package auth

import (
	"crypto/rand"
	"errors"
	"fmt"
	"os"
)

const secretBytes = 32

func LoadSecret(path string) ([]byte, error) {
	secret, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return createSecret(path)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to read jwt secret: %w", err)
	}
	if len(secret) < secretBytes {
		return nil, fmt.Errorf("jwt secret must be at least %d bytes: %s", secretBytes, path)
	}
	return secret, nil
}

func createSecret(path string) ([]byte, error) {
	secret := make([]byte, secretBytes)
	_, _ = rand.Read(secret)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return LoadSecret(path)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to create jwt secret: %w", err)
	}
	_, writeErr := file.Write(secret)
	closeErr := file.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return nil, fmt.Errorf("failed to write jwt secret: %w", err)
	}
	return secret, nil
}

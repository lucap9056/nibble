package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const (
	minPasswordLength = 8
	maxPasswordBytes  = 72
	maxLoginFailures  = 5
	failureWindow     = 5 * time.Minute
	SessionTTL        = 24 * time.Hour
)

var (
	ErrInvalidPassword        = errors.New("invalid password")
	ErrPasswordChangeRequired = errors.New("password change required")
	ErrTooManyAttempts        = errors.New("too many failed attempts")
	ErrWeakPassword           = fmt.Errorf("password must be %d to %d bytes and differ from the initial password", minPasswordLength, maxPasswordBytes)
)

type Credentials struct {
	mu              sync.RWMutex
	path            string
	secret          []byte
	initialPassword string
	hash            []byte
	signingKey      []byte
	failures        []time.Time
}

func LoadCredentials(path string, secret []byte, initialPassword string) (*Credentials, error) {
	c := &Credentials{path: path, secret: secret, initialPassword: initialPassword}
	hash, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return nil, fmt.Errorf("failed to read password file: %w", err)
	}
	c.setHash(hash)
	return c, nil
}

func (c *Credentials) setHash(hash []byte) {
	mac := hmac.New(sha256.New, c.secret)
	mac.Write(hash)
	c.hash = hash
	c.signingKey = mac.Sum(nil)
}

func (c *Credentials) matches(password string) bool {
	passwordBytes := []byte(password)
	if c.hash == nil {
		initialBytes := []byte(c.initialPassword)
		return subtle.ConstantTimeCompare(passwordBytes, initialBytes) == 1
	}
	return bcrypt.CompareHashAndPassword(c.hash, passwordBytes) == nil
}

func (c *Credentials) checkPassword(password string, now time.Time) error {
	recent := c.failures[:0]
	for _, failedAt := range c.failures {
		if now.Sub(failedAt) < failureWindow {
			recent = append(recent, failedAt)
		}
	}
	c.failures = recent
	if len(c.failures) >= maxLoginFailures {
		return ErrTooManyAttempts
	}
	if !c.matches(password) {
		c.failures = append(c.failures, now)
		return ErrInvalidPassword
	}
	return nil
}

func (c *Credentials) Login(password string, now time.Time) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.checkPassword(password, now); err != nil {
		return "", err
	}
	if c.hash == nil {
		return "", ErrPasswordChangeRequired
	}
	return Issue(c.signingKey, SessionTTL, now)
}

func (c *Credentials) ChangePassword(currentPassword, newPassword string, now time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.checkPassword(currentPassword, now); err != nil {
		return err
	}
	if len(newPassword) < minPasswordLength || len(newPassword) > maxPasswordBytes || newPassword == c.initialPassword {
		return ErrWeakPassword
	}

	newPasswordBytes := []byte(newPassword)
	hash, err := bcrypt.GenerateFromPassword(newPasswordBytes, bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("failed to hash password: %w", err)
	}
	tempPath := c.path + ".tmp"
	if err := os.WriteFile(tempPath, hash, 0o600); err != nil {
		return fmt.Errorf("failed to write password file: %w", err)
	}
	if err := os.Rename(tempPath, c.path); err != nil {
		return fmt.Errorf("failed to replace password file: %w", err)
	}
	c.setHash(hash)
	return nil
}

func (c *Credentials) Verify(tokenString string) error {
	c.mu.RLock()
	signingKey := c.signingKey
	c.mu.RUnlock()
	if signingKey == nil {
		return ErrPasswordChangeRequired
	}
	return Verify(signingKey, tokenString)
}

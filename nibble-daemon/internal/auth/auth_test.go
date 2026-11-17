package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var testSecret = []byte("0123456789abcdef0123456789abcdef")

const strongPassword = "correct horse battery"

func newCredentials(t *testing.T) (*Credentials, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "nibbled.passwd")
	credentials, err := LoadCredentials(path, testSecret, "admin")
	require.NoError(t, err)
	return credentials, path
}

func TestVerifyRejectsUnsafeTokens(t *testing.T) {
	expiry := time.Now().Add(time.Hour).Unix()
	unsignedClaims := jwt.MapClaims{"iss": issuer, "exp": expiry}
	unsignedToken := jwt.NewWithClaims(jwt.SigningMethodNone, unsignedClaims)
	unsigned, err := unsignedToken.SignedString(jwt.UnsafeAllowNoneSignatureType)
	require.NoError(t, err)
	noneErr := Verify(testSecret, unsigned)
	assert.Error(t, noneErr)

	noExpiryClaims := jwt.MapClaims{"iss": issuer}
	noExpiryToken := jwt.NewWithClaims(jwt.SigningMethodHS256, noExpiryClaims)
	noExpiry, err := noExpiryToken.SignedString(testSecret)
	require.NoError(t, err)
	noExpiryErr := Verify(testSecret, noExpiry)
	assert.ErrorIs(t, noExpiryErr, jwt.ErrTokenRequiredClaimMissing)
}

func TestPasswordChangePersistsAndRevokesTokens(t *testing.T) {
	credentials, path := newCredentials(t)
	now := time.Now()

	sameErr := credentials.ChangePassword("admin", "admin", now)
	assert.ErrorIs(t, sameErr, ErrWeakPassword)
	changeErr := credentials.ChangePassword("admin", strongPassword, now)
	require.NoError(t, changeErr)
	token, err := credentials.Login(strongPassword, now)
	require.NoError(t, err)

	reloaded, err := LoadCredentials(path, testSecret, "admin")
	require.NoError(t, err)
	reloadedErr := reloaded.Verify(token)
	assert.NoError(t, reloadedErr)

	rotateErr := credentials.ChangePassword(strongPassword, "another strong password", now)
	require.NoError(t, rotateErr)
	revokedErr := credentials.Verify(token)
	assert.Error(t, revokedErr)
}

func TestLoginLocksAfterRepeatedFailures(t *testing.T) {
	credentials, _ := newCredentials(t)
	now := time.Now()
	for range maxLoginFailures {
		_, err := credentials.Login("wrong", now)
		require.ErrorIs(t, err, ErrInvalidPassword)
	}

	_, lockedErr := credentials.Login("admin", now)
	assert.ErrorIs(t, lockedErr, ErrTooManyAttempts)
	later := now.Add(failureWindow)
	_, unlockedErr := credentials.Login("admin", later)
	assert.ErrorIs(t, unlockedErr, ErrPasswordChangeRequired)
}

func noContent(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}

func TestRequireOrigin(t *testing.T) {
	publicURL, err := url.Parse("https://nibble.example.com")
	require.NoError(t, err)
	next := http.HandlerFunc(noContent)
	handler := RequireOrigin(publicURL, next)
	cases := []struct {
		host     string
		origin   string
		expected int
	}{
		{"127.0.0.1:8081", "", http.StatusNoContent},
		{"[::1]:8081", "", http.StatusNoContent},
		{"localhost:8081", "http://localhost:8081", http.StatusNoContent},
		{"nibble.example.com", "https://nibble.example.com", http.StatusNoContent},
		{"attacker.example", "", http.StatusForbidden},
		{"127.0.0.1:8081", "http://localhost:3000", http.StatusForbidden},
		{"nibble.example.com", "https://attacker.example", http.StatusForbidden},
		{"nibble.example.com", "null", http.StatusForbidden},
	}

	for _, c := range cases {
		req := httptest.NewRequest(http.MethodGet, "/api/bubbles", nil)
		req.Host = c.host
		if c.origin != "" {
			req.Header.Set("Origin", c.origin)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		assert.Equal(t, c.expected, rec.Code, "host=%s origin=%s", c.host, c.origin)
	}
}

func TestHandlerLoginFlow(t *testing.T) {
	credentials, _ := newCredentials(t)
	next := http.HandlerFunc(noContent)
	protected := RequireToken(credentials, next)
	handler := NewHandler(credentials, protected)
	request := func(method, path, body, authorization string) *httptest.ResponseRecorder {
		bodyReader := strings.NewReader(body)
		req := httptest.NewRequest(method, path, bodyReader)
		req.Header.Set("Content-Type", "application/json")
		if authorization != "" {
			req.Header.Set("Authorization", authorization)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	anonymous := request(http.MethodGet, "/api/bubbles", "", "")
	assert.Equal(t, http.StatusUnauthorized, anonymous.Code)
	initial := request(http.MethodPost, "/api/login", `{"password":"admin"}`, "")
	assert.Equal(t, http.StatusForbidden, initial.Code)

	changeBody := `{"currentPassword":"admin","newPassword":"` + strongPassword + `"}`
	changed := request(http.MethodPut, "/api/password", changeBody, "")
	require.Equal(t, http.StatusNoContent, changed.Code)

	loginBody := `{"password":"` + strongPassword + `"}`
	login := request(http.MethodPost, "/api/login", loginBody, "")
	require.Equal(t, http.StatusOK, login.Code)
	var session struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expiresAt"`
	}
	responseBody := login.Body.Bytes()
	decodeErr := json.Unmarshal(responseBody, &session)
	require.NoError(t, decodeErr)
	assert.NotZero(t, session.ExpiresAt)

	authorized := request(http.MethodGet, "/api/bubbles", "", "Bearer "+session.Token)
	assert.Equal(t, http.StatusNoContent, authorized.Code)
	invalid := request(http.MethodGet, "/api/bubbles", "", "Bearer not-a-token")
	assert.Equal(t, http.StatusUnauthorized, invalid.Code)
}

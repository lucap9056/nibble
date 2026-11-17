package auth

import (
	"encoding/json"
	"errors"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxBodyBytes = 1 << 16

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		slog.Error("write response failed", "err", err)
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	body := map[string]string{"error": message}
	writeJSON(w, status, body)
}

func isLoopbackHost(hostname string) bool {
	if strings.EqualFold(hostname, "localhost") {
		return true
	}
	ip := net.ParseIP(hostname)
	return ip != nil && ip.IsLoopback()
}

func hostname(hostport string) string {
	host, _, err := net.SplitHostPort(hostport)
	if err != nil {
		return strings.Trim(hostport, "[]")
	}
	return host
}

func RequireOrigin(publicURL *url.URL, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestHost := hostname(r.Host)
		publicHost := ""
		if publicURL != nil {
			publicHost = publicURL.Hostname()
		}
		if !isLoopbackHost(requestHost) && !strings.EqualFold(requestHost, publicHost) {
			writeError(w, http.StatusForbidden, "host not allowed")
			return
		}

		origin := r.Header.Get("Origin")
		if origin == "" {
			next.ServeHTTP(w, r)
			return
		}
		originURL, err := url.Parse(origin)
		sameOrigin := err == nil && strings.EqualFold(originURL.Host, r.Host)
		publicOrigin := err == nil && publicURL != nil &&
			strings.EqualFold(originURL.Scheme, publicURL.Scheme) &&
			strings.EqualFold(originURL.Host, publicURL.Host)
		if !sameOrigin && !publicOrigin {
			writeError(w, http.StatusForbidden, "origin not allowed")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func RequireJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost || r.Method == http.MethodPut {
			contentType := r.Header.Get("Content-Type")
			mediaType, _, _ := mime.ParseMediaType(contentType)
			if mediaType != "application/json" {
				writeError(w, http.StatusUnsupportedMediaType, "content type must be application/json")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func RequireToken(credentials *Credentials, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization := r.Header.Get("Authorization")
		scheme, tokenString, found := strings.Cut(authorization, " ")
		if !found || !strings.EqualFold(scheme, "Bearer") {
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeError(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		if err := credentials.Verify(tokenString); err != nil {
			w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token"`)
			writeError(w, http.StatusUnauthorized, "invalid token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func credentialStatus(err error) int {
	switch {
	case errors.Is(err, ErrInvalidPassword):
		return http.StatusUnauthorized
	case errors.Is(err, ErrPasswordChangeRequired):
		return http.StatusForbidden
	case errors.Is(err, ErrTooManyAttempts):
		return http.StatusTooManyRequests
	case errors.Is(err, ErrWeakPassword):
		return http.StatusBadRequest
	default:
		return http.StatusInternalServerError
	}
}

func decodeBody(w http.ResponseWriter, r *http.Request, input any) bool {
	bodyReader := http.MaxBytesReader(w, r.Body, maxBodyBytes)
	decoder := json.NewDecoder(bodyReader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(input); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body")
		return false
	}
	return true
}

func NewHandler(credentials *Credentials, protected http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Password string `json:"password"`
		}
		if !decodeBody(w, r, &input) {
			return
		}
		now := time.Now()
		token, err := credentials.Login(input.Password, now)
		if err != nil {
			status := credentialStatus(err)
			message := err.Error()
			writeError(w, status, message)
			return
		}
		expiresAt := now.Add(SessionTTL)
		body := map[string]any{"token": token, "expiresAt": expiresAt}
		writeJSON(w, http.StatusOK, body)
	})
	mux.HandleFunc("PUT /api/password", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			CurrentPassword string `json:"currentPassword"`
			NewPassword     string `json:"newPassword"`
		}
		if !decodeBody(w, r, &input) {
			return
		}
		now := time.Now()
		if err := credentials.ChangePassword(input.CurrentPassword, input.NewPassword, now); err != nil {
			status := credentialStatus(err)
			message := err.Error()
			if status == http.StatusInternalServerError {
				slog.Error("password change failed", "err", err)
				message = "password change failed"
			}
			writeError(w, status, message)
			return
		}
		slog.Info("admin password changed")
		w.WriteHeader(http.StatusNoContent)
	})
	mux.Handle("/", protected)
	return mux
}

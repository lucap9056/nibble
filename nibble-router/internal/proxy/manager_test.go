package proxy_test

import (
	"net/http"
	"net/http/httptest"
	"router/internal/proxy"
	"router/internal/routes"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestServeHTTP_RedirectsBareDirectoryPrefix(t *testing.T) {
	manager := proxy.NewManager()
	entries := []routes.Entry{{RoutePath: "/docs/", SocketPath: "docs.sock"}}
	err := manager.SetRoutes(entries)
	require.NoError(t, err)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/docs?x=1", nil)
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")

	manager.ServeHTTP(recorder, request)

	header := recorder.Header()
	location := header.Get("Location")
	connection := header.Get("Connection")

	assert.Equal(t, http.StatusPermanentRedirect, recorder.Code)
	assert.Equal(t, "/docs/?x=1", location)
	assert.Equal(t, "close", connection)
}

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
	require.NoError(t, manager.SetRoutes([]routes.Entry{{RoutePath: "/docs/", SocketPath: "docs.sock"}}))

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/docs?x=1", nil)
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	manager.ServeHTTP(recorder, request)

	assert.Equal(t, http.StatusPermanentRedirect, recorder.Code)
	assert.Equal(t, "/docs/?x=1", recorder.Header().Get("Location"))
	assert.Equal(t, "close", recorder.Header().Get("Connection"))
}

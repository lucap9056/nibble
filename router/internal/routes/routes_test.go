package routes_test

import (
	"router/internal/routes"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewTable_RejectsInvalidEntries(t *testing.T) {
	invalidEntries := [][]routes.Entry{
		{{RoutePath: "", SocketPath: "x"}},
		{{RoutePath: "/", SocketPath: "x"}},
		{{RoutePath: "api", SocketPath: "x"}},
		{{RoutePath: "/api/", SocketPath: "x"}},
		{{RoutePath: "/a//b", SocketPath: "x"}},
		{{RoutePath: "/a/./b", SocketPath: "x"}},
		{{RoutePath: "/a/../b", SocketPath: "x"}},
		{{RoutePath: "/a b", SocketPath: "x"}},
		{{RoutePath: "/a", SocketPath: ""}},
		{{RoutePath: "/a", SocketPath: "x"}, {RoutePath: "/a", SocketPath: "y"}},
	}
	for _, entries := range invalidEntries {
		_, err := routes.NewTable(entries)
		assert.Error(t, err, "%+v", entries)
	}
}

func TestResolve(t *testing.T) {
	api := routes.Entry{RoutePath: "/api", SocketPath: "api.sock"}
	user := routes.Entry{RoutePath: "/api/user", SocketPath: "user.sock"}
	entries := []routes.Entry{api, user}
	table, err := routes.NewTable(entries)
	require.NoError(t, err)

	matches := map[string]routes.Resolved{
		"/api":            {Entry: api, Prefix: "/api", UpstreamPath: "/"},
		"/api/?x=1":       {Entry: api, Prefix: "/api", UpstreamPath: "/?x=1"},
		"/api//double":    {Entry: api, Prefix: "/api", UpstreamPath: "//double"},
		"/api/users":      {Entry: api, Prefix: "/api", UpstreamPath: "/users"},
		"/api/user":       {Entry: user, Prefix: "/api/user", UpstreamPath: "/"},
		"/api/user/1?x=1": {Entry: user, Prefix: "/api/user", UpstreamPath: "/1?x=1"},
	}
	for target, expected := range matches {
		resolved, ok := table.Resolve(target)
		require.True(t, ok, target)
		assert.Equal(t, expected, resolved, target)
	}

	unmatchedTargets := []string{"/", "/apix", "/other", "api", "*", ""}
	for _, target := range unmatchedTargets {
		_, ok := table.Resolve(target)
		assert.False(t, ok, target)
	}
}

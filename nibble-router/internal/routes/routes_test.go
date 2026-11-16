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
		{{RoutePath: "//", SocketPath: "x"}},
		{{RoutePath: "api/", SocketPath: "x"}},
		{{RoutePath: "api", SocketPath: "x"}},
		{{RoutePath: "/a//b/", SocketPath: "x"}},
		{{RoutePath: "/a//b", SocketPath: "x"}},
		{{RoutePath: "/a/./b/", SocketPath: "x"}},
		{{RoutePath: "/a/../b", SocketPath: "x"}},
		{{RoutePath: "/a b/", SocketPath: "x"}},
		{{RoutePath: "/a/", SocketPath: ""}},
		{{RoutePath: "/a/", SocketPath: "x"}, {RoutePath: "/a/", SocketPath: "y"}},
		{{RoutePath: "/a", SocketPath: "x"}, {RoutePath: "/a", SocketPath: "y"}},
		{{RoutePath: "/", SocketPath: "x"}, {RoutePath: "/", SocketPath: "y"}},
	}
	for _, entries := range invalidEntries {
		_, err := routes.NewTable(entries)
		assert.Error(t, err, "%+v", entries)
	}
}

func TestNewTable_AcceptsMountAndDirectoryOnSamePrefix(t *testing.T) {
	_, err := routes.NewTable([]routes.Entry{
		{RoutePath: "/", SocketPath: "root.sock"},
		{RoutePath: "/a", SocketPath: "a.sock"},
		{RoutePath: "/a/", SocketPath: "a-index.sock"},
	})
	assert.NoError(t, err)
}

func assertResolves(t *testing.T, table routes.Table, matches map[string]routes.Resolved, unmatched []string) {
	t.Helper()
	for target, expected := range matches {
		resolved, ok := table.Resolve(target)
		require.True(t, ok, target)
		assert.Equal(t, expected, resolved, target)
	}
	for _, target := range unmatched {
		_, ok := table.Resolve(target)
		assert.False(t, ok, target)
	}
}

func TestResolve_Mounts(t *testing.T) {
	api := routes.Entry{RoutePath: "/api", SocketPath: "api.sock"}
	user := routes.Entry{RoutePath: "/api/user", SocketPath: "user.sock"}
	table, err := routes.NewTable([]routes.Entry{api, user})
	require.NoError(t, err)

	assertResolves(t, table, map[string]routes.Resolved{
		"/api":            {Entry: api, Prefix: "/api", UpstreamPath: "/"},
		"/api?x=1":        {Entry: api, Prefix: "/api", UpstreamPath: "/?x=1"},
		"/api/":           {Entry: api, Prefix: "/api", UpstreamPath: "/"},
		"/api/?x=1":       {Entry: api, Prefix: "/api", UpstreamPath: "/?x=1"},
		"/api//double":    {Entry: api, Prefix: "/api", UpstreamPath: "//double"},
		"/api/users":      {Entry: api, Prefix: "/api", UpstreamPath: "/users"},
		"/api/user":       {Entry: user, Prefix: "/api/user", UpstreamPath: "/"},
		"/api/user/1?x=1": {Entry: user, Prefix: "/api/user", UpstreamPath: "/1?x=1"},
	}, []string{"/", "/apix", "/other", "api", "*", ""})
}

func TestResolve_DirectoryRedirectsBarePrefix(t *testing.T) {
	docs := routes.Entry{RoutePath: "/docs/", SocketPath: "docs.sock"}
	table, err := routes.NewTable([]routes.Entry{docs})
	require.NoError(t, err)

	assertResolves(t, table, map[string]routes.Resolved{
		"/docs":       {Entry: docs, Prefix: "/docs", RedirectTo: "/docs/"},
		"/docs?x=1":   {Entry: docs, Prefix: "/docs", RedirectTo: "/docs/?x=1"},
		"/docs/":      {Entry: docs, Prefix: "/docs", UpstreamPath: "/"},
		"/docs/a/b?x": {Entry: docs, Prefix: "/docs", UpstreamPath: "/a/b?x"},
	}, []string{"/", "/docsx", "/other"})
}

func TestResolve_MountWinsBarePrefixOverDirectory(t *testing.T) {
	foo := routes.Entry{RoutePath: "/foo", SocketPath: "foo.sock"}
	fooIndex := routes.Entry{RoutePath: "/foo/", SocketPath: "foo-index.sock"}
	fooBar := routes.Entry{RoutePath: "/foo/bar", SocketPath: "foo-bar.sock"}
	table, err := routes.NewTable([]routes.Entry{foo, fooIndex, fooBar})
	require.NoError(t, err)

	assertResolves(t, table, map[string]routes.Resolved{
		"/foo":       {Entry: foo, Prefix: "/foo", UpstreamPath: "/"},
		"/foo?x=1":   {Entry: foo, Prefix: "/foo", UpstreamPath: "/?x=1"},
		"/foo/":      {Entry: fooIndex, Prefix: "/foo", UpstreamPath: "/"},
		"/foo/x":     {Entry: fooIndex, Prefix: "/foo", UpstreamPath: "/x"},
		"/foo/bar":   {Entry: fooBar, Prefix: "/foo/bar", UpstreamPath: "/"},
		"/foo/bar/1": {Entry: fooBar, Prefix: "/foo/bar", UpstreamPath: "/1"},
	}, nil)
}

func TestResolve_RootFallback(t *testing.T) {
	root := routes.Entry{RoutePath: "/", SocketPath: "root.sock"}
	api := routes.Entry{RoutePath: "/api", SocketPath: "api.sock"}
	table, err := routes.NewTable([]routes.Entry{root, api})
	require.NoError(t, err)

	assertResolves(t, table, map[string]routes.Resolved{
		"/":        {Entry: root, Prefix: "", UpstreamPath: "/"},
		"/?x=1":    {Entry: root, Prefix: "", UpstreamPath: "/?x=1"},
		"/apix":    {Entry: root, Prefix: "", UpstreamPath: "/apix"},
		"/other/1": {Entry: root, Prefix: "", UpstreamPath: "/other/1"},
		"/api/x":   {Entry: api, Prefix: "/api", UpstreamPath: "/x"},
		"//double": {Entry: root, Prefix: "", UpstreamPath: "//double"},
	}, []string{"api", "*", ""})
}

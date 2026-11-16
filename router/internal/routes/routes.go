package routes

import (
	"fmt"
	"regexp"
	"strings"
)

var segmentPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]+$`)

type Entry struct {
	RoutePath  string
	SocketPath string
}

type Table struct {
	mounts      map[string]Entry
	directories map[string]Entry
}

type Resolved struct {
	Entry        Entry
	Prefix       string
	UpstreamPath string
	RedirectTo   string
}

func parseRoutePath(routePath string) (prefix string, isDirectory bool, ok bool) {
	if !strings.HasPrefix(routePath, "/") {
		return "", false, false
	}
	prefix, isDirectory = strings.CutSuffix(routePath, "/")
	if prefix == "" {
		return "", isDirectory, true
	}
	for _, segment := range strings.Split(prefix[1:], "/") {
		if segment == "." || segment == ".." || !segmentPattern.MatchString(segment) {
			return "", false, false
		}
	}
	return prefix, isDirectory, true
}

func NewTable(entries []Entry) (Table, error) {
	table := Table{mounts: map[string]Entry{}, directories: map[string]Entry{}}
	for _, entry := range entries {
		prefix, isDirectory, ok := parseRoutePath(entry.RoutePath)
		if !ok {
			return Table{}, fmt.Errorf("Invalid route path: %q", entry.RoutePath)
		}
		if entry.SocketPath == "" {
			return Table{}, fmt.Errorf("Route %s must have a socketPath", entry.RoutePath)
		}
		target := table.mounts
		if isDirectory {
			target = table.directories
		}
		if _, exists := target[prefix]; exists {
			return Table{}, fmt.Errorf("Duplicate route path: %s", entry.RoutePath)
		}
		target[prefix] = entry
	}
	return table, nil
}

func (table Table) Resolve(requestTarget string) (Resolved, bool) {
	if !strings.HasPrefix(requestTarget, "/") {
		return Resolved{}, false
	}

	pathname, search := requestTarget, ""
	if queryIndex := strings.IndexByte(requestTarget, '?'); queryIndex != -1 {
		pathname, search = requestTarget[:queryIndex], requestTarget[queryIndex:]
	}

	forward := func(entry Entry, prefix, upstreamPath string) (Resolved, bool) {
		return Resolved{Entry: entry, Prefix: prefix, UpstreamPath: upstreamPath + search}, true
	}

	for prefix := pathname; ; prefix = prefix[:strings.LastIndexByte(prefix, '/')] {
		rest := pathname[len(prefix):]
		if rest == "" {
			if entry, ok := table.mounts[prefix]; ok {
				return forward(entry, prefix, "/")
			}
			if entry, ok := table.directories[prefix]; ok {
				return Resolved{Entry: entry, Prefix: prefix, RedirectTo: prefix + "/" + search}, true
			}
		} else {
			if entry, ok := table.directories[prefix]; ok {
				return forward(entry, prefix, rest)
			}
			if entry, ok := table.mounts[prefix]; ok {
				return forward(entry, prefix, rest)
			}
		}
		if prefix == "" {
			return Resolved{}, false
		}
	}
}

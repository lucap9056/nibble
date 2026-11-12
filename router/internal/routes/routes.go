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

type Table map[string]Entry

type Resolved struct {
	Entry        Entry
	Prefix       string
	UpstreamPath string
}

func isValidRoutePath(path string) bool {
	if !strings.HasPrefix(path, "/") {
		return false
	}
	for _, segment := range strings.Split(path[1:], "/") {
		if segment == "." || segment == ".." || !segmentPattern.MatchString(segment) {
			return false
		}
	}
	return true
}

func NewTable(entries []Entry) (Table, error) {
	table := make(Table, len(entries))
	for _, entry := range entries {
		if !isValidRoutePath(entry.RoutePath) {
			return nil, fmt.Errorf("Invalid route path: %q", entry.RoutePath)
		}
		if entry.SocketPath == "" {
			return nil, fmt.Errorf("Route %s must have a socketPath", entry.RoutePath)
		}
		if _, exists := table[entry.RoutePath]; exists {
			return nil, fmt.Errorf("Duplicate route path: %s", entry.RoutePath)
		}
		table[entry.RoutePath] = entry
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

	for prefix := pathname; prefix != ""; prefix = prefix[:strings.LastIndexByte(prefix, '/')] {
		entry, ok := table[prefix]
		if !ok {
			continue
		}
		upstreamPath := pathname[len(prefix):]
		if upstreamPath == "" {
			upstreamPath = "/"
		}
		return Resolved{
			Entry:        entry,
			Prefix:       prefix,
			UpstreamPath: upstreamPath + search,
		}, true
	}
	return Resolved{}, false
}

package routes

import (
	"fmt"
	"regexp"
	"strings"
)

var namePattern = regexp.MustCompile(`^[A-Za-z0-9._~-]+$`)

type Entry struct {
	Name       string
	SocketPath string
}

type Table map[string]Entry

type Resolved struct {
	Entry        Entry
	Prefix       string
	UpstreamPath string
}

func NewTable(entries []Entry) (Table, error) {
	table := make(Table, len(entries))
	for _, entry := range entries {
		if !namePattern.MatchString(entry.Name) {
			return nil, fmt.Errorf("Invalid route name: %q", entry.Name)
		}
		if entry.SocketPath == "" {
			return nil, fmt.Errorf("Route %s must have a socketPath", entry.Name)
		}
		if _, exists := table[entry.Name]; exists {
			return nil, fmt.Errorf("Duplicate route name: %s", entry.Name)
		}
		table[entry.Name] = entry
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

	name, rest, hasRest := strings.Cut(pathname[1:], "/")
	entry, ok := table[name]
	if !ok {
		return Resolved{}, false
	}

	upstreamPath := "/"
	if hasRest {
		upstreamPath = "/" + rest
	}
	return Resolved{
		Entry:        entry,
		Prefix:       "/" + name,
		UpstreamPath: upstreamPath + search,
	}, true
}

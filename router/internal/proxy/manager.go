package proxy

import (
	"net/http"
	"router/internal/routes"
	"sync/atomic"
)

type Generation struct {
	table      routes.Table
	forwarders map[string]*Forwarder
}

type Manager struct {
	state atomic.Pointer[Generation]
}

func NewManager() *Manager {
	m := &Manager{}
	m.state.Store(&Generation{forwarders: map[string]*Forwarder{}})
	return m
}

func (m *Manager) SetRoutes(entries []routes.Entry) error {
	table, err := routes.NewTable(entries)
	if err != nil {
		return err
	}

	previous := m.state.Load()
	forwarders := make(map[string]*Forwarder, len(entries))
	for _, entry := range entries {
		if _, ok := forwarders[entry.SocketPath]; ok {
			continue
		}
		if forwarder, ok := previous.forwarders[entry.SocketPath]; ok {
			forwarders[entry.SocketPath] = forwarder
		} else {
			forwarders[entry.SocketPath] = NewForwarder(entry.SocketPath)
		}
	}

	m.state.Store(&Generation{table: table, forwarders: forwarders})

	for socketPath, forwarder := range previous.forwarders {
		if _, kept := forwarders[socketPath]; !kept {
			forwarder.CloseIdleConnections()
		}
	}
	return nil
}

func (m *Manager) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	state := m.state.Load()
	resolved, ok := state.table.Resolve(r.RequestURI)
	if !ok {
		writeError(w, r, http.StatusNotFound)
		return
	}
	if resolved.RedirectTo != "" {
		writeRedirect(w, r, resolved.RedirectTo)
		return
	}
	state.forwarders[resolved.Entry.SocketPath].Forward(w, r, resolved.UpstreamPath, resolved.Prefix)
}

package api

import (
	"daemon/internal/engine"
	"daemon/internal/storage"
	"net/http"
	"sync"
)

const maxBodyBytes = 1 << 20

type API struct {
	mux     *http.ServeMux
	storage *storage.Storage
	control *engine.Control
	writeMu sync.Mutex
}

func New(store *storage.Storage, control *engine.Control) *API {
	mux := http.NewServeMux()
	a := &API{mux: mux, storage: store, control: control}
	mux.HandleFunc("GET /api/bubbles", a.listBubbles)
	mux.HandleFunc("GET /api/bubbles/{name...}", a.getBubble)
	mux.HandleFunc("PUT /api/bubbles/{name...}", a.saveBubble)
	mux.HandleFunc("POST /api/bubbles/{name...}", a.restartBubble)
	mux.HandleFunc("DELETE /api/bubbles/{name...}", a.deleteBubble)
	mux.HandleFunc("POST /api/snapshots/{name...}", a.buildSnapshot)
	mux.HandleFunc("DELETE /api/snapshots/{name...}", a.deleteSnapshot)
	return a
}

func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.mux.ServeHTTP(w, r)
}

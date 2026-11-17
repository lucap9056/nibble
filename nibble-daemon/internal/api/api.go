package api

import (
	"daemon/internal/engine"
	"daemon/internal/storage"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"sync"
)

const maxBodyBytes = 1 << 20

var bubbleNameSegment = regexp.MustCompile(`^[A-Za-z0-9._~-]+$`)

func isBubbleName(name string) bool {
	for segment := range strings.SplitSeq(name, "/") {
		if segment == "." || segment == ".." || !bubbleNameSegment.MatchString(segment) {
			return false
		}
	}
	return true
}

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
	mux.HandleFunc("GET /api/bubbles/{name...}", named(a.getBubble))
	mux.HandleFunc("PUT /api/bubbles/{name...}", named(a.saveBubble))
	mux.HandleFunc("POST /api/bubbles/{name...}", named(a.restartBubble))
	mux.HandleFunc("DELETE /api/bubbles/{name...}", named(a.deleteBubble))
	mux.HandleFunc("POST /api/snapshots/{name...}", named(a.buildSnapshot))
	mux.HandleFunc("DELETE /api/snapshots/{name...}", named(a.deleteSnapshot))
	return a
}

func named(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		if !isBubbleName(name) {
			nameErr := fmt.Errorf("%w: %s", errInvalidBubbleName, name)
			writeError(w, http.StatusBadRequest, nameErr)
			return
		}
		next(w, r)
	}
}

func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	a.mux.ServeHTTP(w, r)
}

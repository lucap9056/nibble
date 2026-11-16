package proxy

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

type errorBody struct {
	Error string `json:"error"`
}

func writeError(w http.ResponseWriter, r *http.Request, status int) {
	body, _ := json.Marshal(errorBody{Error: http.StatusText(status)})

	header := w.Header()
	header.Set("Content-Type", "application/json;charset=utf-8")
	header.Set("Content-Length", strconv.Itoa(len(body)))
	if isUpgradeRequest(r.Header) {
		header.Set("Connection", "close")
	}
	w.WriteHeader(status)
	w.Write(body)
}

func writeRedirect(w http.ResponseWriter, r *http.Request, location string) {
	header := w.Header()
	header.Set("Location", location)
	header.Set("Content-Length", "0")
	if isUpgradeRequest(r.Header) {
		header.Set("Connection", "close")
	}
	w.WriteHeader(http.StatusPermanentRedirect)
}

func isUpgradeRequest(header http.Header) bool {
	if header.Get("Upgrade") == "" {
		return false
	}
	for _, value := range header.Values("Connection") {
		for token := range strings.SplitSeq(value, ",") {
			if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
				return true
			}
		}
	}
	return false
}

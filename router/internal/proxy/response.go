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

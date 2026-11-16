package proxy

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

const (
	HandshakeTimeout       = 10 * time.Second
	DefaultMaxIdleConns    = 32
	DefaultIdleConnTimeout = 90 * time.Second
)

const forwardedHeaderPrefix = "x-forwarded-"

type upstreamTarget struct {
	url    *url.URL
	prefix string
}

type upstreamTargetKey struct{}

type upgradeAwareTransport struct {
	plain   *http.Transport
	upgrade *http.Transport
}

func (t *upgradeAwareTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if isUpgradeRequest(req.Header) {
		return t.upgrade.RoundTrip(req)
	}
	return t.plain.RoundTrip(req)
}

func (t *upgradeAwareTransport) CloseIdleConnections() {
	t.plain.CloseIdleConnections()
	t.upgrade.CloseIdleConnections()
}

type Forwarder struct {
	socketPath   string
	transport    *upgradeAwareTransport
	reverseProxy *httputil.ReverseProxy
}

func NewForwarder(socketPath string) *Forwarder {
	dialContext := func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socketPath)
	}

	newTransport := func(responseHeaderTimeout time.Duration) *http.Transport {
		return &http.Transport{
			DialContext:           dialContext,
			MaxIdleConnsPerHost:   DefaultMaxIdleConns,
			IdleConnTimeout:       DefaultIdleConnTimeout,
			DisableCompression:    true,
			ResponseHeaderTimeout: responseHeaderTimeout,
		}
	}

	f := &Forwarder{
		socketPath: socketPath,
		transport: &upgradeAwareTransport{
			plain:   newTransport(0),
			upgrade: newTransport(HandshakeTimeout),
		},
	}
	f.reverseProxy = &httputil.ReverseProxy{
		Rewrite:        rewrite,
		Transport:      f.transport,
		BufferPool:     sharedBufferPool,
		FlushInterval:  -1,
		ModifyResponse: closeAfterRejectedUpgrade,
		ErrorHandler:   handleUpstreamError,
	}
	return f
}

func (f *Forwarder) Forward(w http.ResponseWriter, r *http.Request, upstreamPath, prefix string) {
	target, err := toUpstreamURL(upstreamPath)
	if err != nil {
		writeError(w, r, http.StatusBadRequest)
		return
	}

	ctx := context.WithValue(r.Context(), upstreamTargetKey{}, upstreamTarget{url: target, prefix: prefix})
	f.reverseProxy.ServeHTTP(w, r.WithContext(ctx))
}

func (f *Forwarder) CloseIdleConnections() {
	f.transport.CloseIdleConnections()
}

func toUpstreamURL(upstreamPath string) (*url.URL, error) {
	rawPath, rawQuery, hasQuery := strings.Cut(upstreamPath, "?")
	path, err := url.PathUnescape(rawPath)
	if err != nil {
		return nil, err
	}
	return &url.URL{
		Scheme:     "http",
		Host:       "unix-socket",
		Path:       path,
		RawPath:    rawPath,
		RawQuery:   rawQuery,
		ForceQuery: hasQuery && rawQuery == "",
	}, nil
}

func rewrite(pr *httputil.ProxyRequest) {
	target := pr.In.Context().Value(upstreamTargetKey{}).(upstreamTarget)
	pr.Out.URL = target.url

	for name := range pr.Out.Header {
		if strings.HasPrefix(strings.ToLower(name), forwardedHeaderPrefix) {
			delete(pr.Out.Header, name)
		}
	}
	pr.SetXForwarded()
	pr.Out.Header.Set("X-Forwarded-Prefix", target.prefix)
}

func closeAfterRejectedUpgrade(res *http.Response) error {
	if isUpgradeRequest(res.Request.Header) && res.StatusCode != http.StatusSwitchingProtocols {
		res.Header.Set("Connection", "close")
	}
	return nil
}

func handleUpstreamError(w http.ResponseWriter, r *http.Request, err error) {
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		writeError(w, r, http.StatusGatewayTimeout)
		return
	}
	writeError(w, r, http.StatusBadGateway)
}

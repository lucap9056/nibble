package server

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
)

func Listen(addr string) (net.Listener, error) {
	if path, ok := strings.CutPrefix(addr, "unix://"); ok {
		return listenUnix(path)
	}
	return net.Listen("tcp", addr)
}

type unixListener struct {
	*net.UnixListener
	path string
}

func (l *unixListener) Close() error {
	err := l.UnixListener.Close()
	if removeErr := os.Remove(l.path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
		err = errors.Join(err, removeErr)
	}
	return err
}

func listenUnix(path string) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0777); err != nil {
		return nil, err
	}

	tempPath := path + ".temp"
	os.Remove(tempPath)
	os.Remove(path)

	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: tempPath, Net: "unix"})
	if err != nil {
		return nil, err
	}

	listener.SetUnlinkOnClose(false)

	abort := func(err error) (net.Listener, error) {
		listener.Close()
		os.Remove(tempPath)
		return nil, err
	}
	if err := os.Chmod(tempPath, 0666); err != nil {
		return abort(err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return abort(err)
	}
	return &unixListener{UnixListener: listener, path: path}, nil
}

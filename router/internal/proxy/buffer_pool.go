package proxy

import "sync"

const copyBufferSize = 32 * 1024

type bufferPool struct {
	pool sync.Pool
}

func newBufferPool() *bufferPool {
	return &bufferPool{
		pool: sync.Pool{
			New: func() any {
				b := make([]byte, copyBufferSize)
				return &b
			},
		},
	}
}

func (p *bufferPool) Get() []byte {
	return *(p.pool.Get().(*[]byte))
}

func (p *bufferPool) Put(b []byte) {
	p.pool.Put(&b)
}

var sharedBufferPool = newBufferPool()

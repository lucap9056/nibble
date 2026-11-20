//go:build !linux

package privilege

func Drop(sourceDir string, owned Ownership) error {
	return nil
}

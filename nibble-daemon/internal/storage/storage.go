package storage

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"net/url"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schema string

var ErrNotFound = errors.New("bubble not found")

type Bubble struct {
	Name         string `json:"name"`
	SnapshotHash string `json:"snapshotHash"`
	Enabled      bool   `json:"enabled"`
	Routing      bool   `json:"routing"`
}

const bubbleColumns = "name, snapshotHash, enabled, routing"

type Storage struct {
	db *sql.DB
}

func Open(databasePath string) (*Storage, error) {
	params := url.Values{}
	params.Add("_pragma", "journal_mode(WAL)")
	params.Add("_pragma", "busy_timeout(5000)")
	dsn := "file:" + databasePath + "?" + params.Encode()

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	if _, err := db.Exec(schema); err != nil {
		schemaErr := fmt.Errorf("failed to apply schema: %w", err)
		closeErr := db.Close()
		return nil, errors.Join(schemaErr, closeErr)
	}
	return &Storage{db: db}, nil
}

func (s *Storage) Close() error {
	return s.db.Close()
}

func scanBubble(row interface{ Scan(...any) error }) (Bubble, error) {
	var bubble Bubble
	err := row.Scan(&bubble.Name, &bubble.SnapshotHash, &bubble.Enabled, &bubble.Routing)
	return bubble, err
}

func (s *Storage) ListBubbles(ctx context.Context) ([]Bubble, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+bubbleColumns+" FROM bubbles ORDER BY name")
	if err != nil {
		return nil, fmt.Errorf("failed to list bubbles: %w", err)
	}
	defer rows.Close()

	bubbles := []Bubble{}
	for rows.Next() {
		bubble, err := scanBubble(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan bubble: %w", err)
		}
		bubbles = append(bubbles, bubble)
	}
	return bubbles, rows.Err()
}

func (s *Storage) GetBubble(ctx context.Context, name string) (Bubble, error) {
	row := s.db.QueryRowContext(ctx, "SELECT "+bubbleColumns+" FROM bubbles WHERE name = ?", name)
	bubble, err := scanBubble(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Bubble{}, ErrNotFound
	}
	return bubble, err
}

func (s *Storage) SaveBubble(ctx context.Context, bubble Bubble) (Bubble, error) {
	row := s.db.QueryRowContext(ctx,
		`INSERT INTO bubbles (`+bubbleColumns+`) VALUES (?, ?, ?, ?)
		 ON CONFLICT (name) DO UPDATE SET
		   snapshotHash = excluded.snapshotHash,
		   enabled = excluded.enabled,
		   routing = excluded.routing
		 RETURNING `+bubbleColumns,
		bubble.Name, bubble.SnapshotHash, bubble.Enabled, bubble.Routing,
	)
	return scanBubble(row)
}

func (s *Storage) DeleteBubble(ctx context.Context, name string) error {
	result, err := s.db.ExecContext(ctx, "DELETE FROM bubbles WHERE name = ?", name)
	if err != nil {
		return fmt.Errorf("failed to delete bubble: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to delete bubble: %w", err)
	}
	if affected == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Storage) ReplaceBubbles(ctx context.Context, bubbles []Bubble) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, "DELETE FROM bubbles"); err != nil {
		return fmt.Errorf("failed to clear bubbles: %w", err)
	}
	for _, bubble := range bubbles {
		_, err := tx.ExecContext(ctx,
			"INSERT INTO bubbles ("+bubbleColumns+") VALUES (?, ?, ?, ?)",
			bubble.Name, bubble.SnapshotHash, bubble.Enabled, bubble.Routing,
		)
		if err != nil {
			return fmt.Errorf("failed to insert bubble %s: %w", bubble.Name, err)
		}
	}
	return tx.Commit()
}

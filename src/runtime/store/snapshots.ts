import type Database from 'better-sqlite3';

import type { TerminalSnapshot } from '../../shared/types';

interface SnapshotRow {
    terminal_id: string;
    encoding_version: number;
    line_count: number;
    byte_count: number;
    payload: string;
    updated_at: number;
}

function mapSnapshot(row: SnapshotRow): TerminalSnapshot {
    return {
        terminalId: row.terminal_id,
        encodingVersion: row.encoding_version,
        lineCount: row.line_count,
        byteCount: row.byte_count,
        payload: row.payload,
        updatedAt: row.updated_at,
    };
}

/** Pure CRUD over the `terminal_snapshots` table. */
export class SnapshotsStore {
    constructor(private readonly database: Database.Database) {}

    get(terminalId: string): TerminalSnapshot | undefined {
        const row = this.database
            .prepare('SELECT * FROM terminal_snapshots WHERE terminal_id = ?')
            .get(terminalId) as SnapshotRow | undefined;
        return row ? mapSnapshot(row) : undefined;
    }

    save(snapshot: TerminalSnapshot): void {
        this.database
            .prepare(
                `INSERT INTO terminal_snapshots
                 (terminal_id, encoding_version, line_count, byte_count, payload, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(terminal_id) DO UPDATE SET
                   encoding_version = excluded.encoding_version,
                   line_count = excluded.line_count,
                   byte_count = excluded.byte_count,
                   payload = excluded.payload,
                   updated_at = excluded.updated_at`,
            )
            .run(
                snapshot.terminalId,
                snapshot.encodingVersion,
                snapshot.lineCount,
                snapshot.byteCount,
                snapshot.payload,
                snapshot.updatedAt,
            );
    }
}

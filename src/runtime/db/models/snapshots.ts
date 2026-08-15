import { eq } from 'drizzle-orm';

import type { TerminalSnapshot } from '../../../shared/types';
import type { CaxriDrizzleDatabase } from '../connection';
import { terminalSnapshots } from '../schema';

interface SnapshotRow {
    terminalId: string;
    encodingVersion: number;
    lineCount: number;
    byteCount: number;
    payload: string;
    updatedAt: number;
}

function mapSnapshot(row: SnapshotRow): TerminalSnapshot {
    return {
        terminalId: row.terminalId,
        encodingVersion: row.encodingVersion,
        lineCount: row.lineCount,
        byteCount: row.byteCount,
        payload: row.payload,
        updatedAt: row.updatedAt,
    };
}

/**
Pure CRUD over the `terminal_snapshots` table.
 */
export class SnapshotsModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    get(terminalId: string): TerminalSnapshot | undefined {
        const row = this.database
            .select()
            .from(terminalSnapshots)
            .where(eq(terminalSnapshots.terminalId, terminalId))
            .get();
        return row ? mapSnapshot(row) : undefined;
    }

    save(snapshot: TerminalSnapshot): void {
        const values = {
            terminalId: snapshot.terminalId,
            encodingVersion: snapshot.encodingVersion,
            lineCount: snapshot.lineCount,
            byteCount: snapshot.byteCount,
            payload: snapshot.payload,
            updatedAt: snapshot.updatedAt,
        };
        this.database
            .insert(terminalSnapshots)
            .values(values)
            .onConflictDoUpdate({
                target: terminalSnapshots.terminalId,
                set: {
                    encodingVersion: values.encodingVersion,
                    lineCount: values.lineCount,
                    byteCount: values.byteCount,
                    payload: values.payload,
                    updatedAt: values.updatedAt,
                },
            })
            .run();
    }
}

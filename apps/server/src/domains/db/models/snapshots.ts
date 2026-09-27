import type { TerminalSnapshot } from '@caxri/protocol';
import { eq } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { terminalSnapshots } from '../schema';

/**
 * Pure CRUD over the `terminal_snapshots` table.
 */
export class SnapshotsModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    get(terminalId: string): TerminalSnapshot | undefined {
        return this.database
            .select()
            .from(terminalSnapshots)
            .where(eq(terminalSnapshots.terminalId, terminalId))
            .get();
    }

    save(snapshot: TerminalSnapshot): void {
        const values = {
            terminalId: snapshot.terminalId,
            encodingVersion: snapshot.encodingVersion,
            cols: snapshot.cols,
            rows: snapshot.rows,
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
                    cols: values.cols,
                    rows: values.rows,
                    lineCount: values.lineCount,
                    byteCount: values.byteCount,
                    payload: values.payload,
                    updatedAt: values.updatedAt,
                },
            })
            .run();
    }
}

import type { TerminalSnapshot } from '@caxri/protocol';
import {
    CURRENT_TERMINAL_SNAPSHOT_ENCODING_VERSION,
    terminalSnapshotSchema,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { errorLogFields, logEventCatalog } from '@caxri/system';

import type { TerminalStateStore } from './state-store';

/**
 * Owns the asynchronous parser barrier and version gate for durable Terminal screen snapshots.
 */
export class TerminalSnapshotPersistence {
    private readonly finalizations = new Map<string, Promise<void>>();

    constructor(
        private readonly database: TerminalStateStore,
        private readonly logger: StructuredLogger,
    ) {}

    private async persistCapture(
        terminalId: string,
        capture: Promise<TerminalSnapshot>,
    ): Promise<void> {
        try {
            const snapshot = await capture;
            if (this.database.getTerminal(terminalId)) this.database.saveSnapshot(snapshot);
        } catch (error) {
            /**
             * Snapshot persistence is recoverable and must never terminate the shared Server.
             */
            this.logger.write('warn', logEventCatalog.pty.snapshotFailed, {
                fields: { terminalId, ...errorLogFields(error) },
            });
        }
    }

    private async persistAfter(
        terminalId: string,
        previous: Promise<void> | undefined,
        capture: Promise<TerminalSnapshot>,
    ): Promise<void> {
        await previous;
        await this.persistCapture(terminalId, capture);
    }

    pending(terminalId: string): Promise<void> | undefined {
        return this.finalizations.get(terminalId);
    }

    read(terminalId: string): TerminalSnapshot | null {
        const result = terminalSnapshotSchema.safeParse(this.database.getSnapshot(terminalId));
        return result.success &&
            result.data.encodingVersion === CURRENT_TERMINAL_SNAPSHOT_ENCODING_VERSION
            ? result.data
            : null;
    }

    /**
     * Finalizations of one Terminal run in call order, and `pending` reports the newest until it settles. Without the
     * chain an earlier finalization finishing later would drop the newer one from `pending` (a restore then reads the
     * stale row) and could overwrite the newer snapshot.
     */
    finalize(terminalId: string, capture: Promise<TerminalSnapshot>): Promise<void> {
        const previous = this.finalizations.get(terminalId);
        const completion = this.persistAfter(terminalId, previous, capture);
        this.finalizations.set(terminalId, completion);
        void completion.then(() => {
            if (this.finalizations.get(terminalId) === completion)
                this.finalizations.delete(terminalId);
        });
        return completion;
    }
}

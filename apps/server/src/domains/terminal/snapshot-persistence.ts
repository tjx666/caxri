import type { TerminalSnapshot } from '@caxri/protocol';
import { errorMessage, terminalSnapshotSchema } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { LiveTerminal } from '../../terminal-host/engine/types';
import type { TerminalStateStore } from './state-store';

export const CURRENT_TERMINAL_SNAPSHOT_ENCODING_VERSION = 3;

/**
 * Owns the asynchronous parser barrier and version gate for durable Terminal screen snapshots.
 */
export class TerminalSnapshotPersistence {
    private readonly finalizations = new Map<string, Promise<void>>();

    constructor(
        private readonly database: TerminalStateStore,
        private readonly logger: StructuredLogger,
    ) {}

    private async capture(live: LiveTerminal): Promise<void> {
        const terminalId = live.record.id;
        try {
            const snapshot: TerminalSnapshot = {
                terminalId,
                encodingVersion: CURRENT_TERMINAL_SNAPSHOT_ENCODING_VERSION,
                ...(await live.screen.snapshot({ excludeModes: true })),
                updatedAt: Date.now(),
            };
            if (this.database.getTerminal(terminalId)) this.database.saveSnapshot(snapshot);
        } catch (error) {
            /**
             * Snapshot persistence is recoverable and must never terminate the shared Server.
             */
            this.logger.write('warn', logEventCatalog.pty.snapshotFailed, {
                fields: { terminalId, error: errorMessage(error, 'unknown') },
            });
        } finally {
            live.screen.dispose();
            this.finalizations.delete(terminalId);
        }
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

    finalize(live: LiveTerminal): Promise<void> {
        const terminalId = live.record.id;
        const completion = this.capture(live);
        this.finalizations.set(terminalId, completion);
        return completion;
    }
}

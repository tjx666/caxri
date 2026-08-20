import { terminalSnapshotSchema } from '../../shared/ipc/domain';
import { errorMessage } from '../../shared/ipc/errors';
import type { StructuredLogger } from '../../shared/node/logger';
import type { TerminalSnapshot } from '../../shared/types';
import type { CaxriDatabase } from '../db';
import type { LiveTerminal } from './manager-types';

export const CURRENT_TERMINAL_SNAPSHOT_ENCODING_VERSION = 3;

/**
 * Owns the asynchronous parser barrier and version gate for durable Terminal screen snapshots.
 */
export class TerminalSnapshotPersistence {
    private readonly finalizations = new Map<string, Promise<void>>();

    constructor(
        private readonly database: CaxriDatabase,
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
             * Snapshot persistence is recoverable and must never terminate the shared Runtime.
             */
            this.logger.write('warn', 'pty.snapshot_failed', {
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

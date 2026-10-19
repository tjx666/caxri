import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { AgentLifecycleSignal } from './hooks/contract';

/**
 * Why a maintenance window closed. `nextTurn` is a second turn starting inside the window: someone else's work, which
 * must show as running.
 */
type MaintenanceEndReason =
    | 'compactionFinished'
    | 'humanInput'
    | 'nextTurn'
    | 'retired'
    | 'superseded'
    | 'timeout'
    | 'turnFinished'
    | 'undelivered';

interface MaintenanceWindow {
    absorbed: number;
    hasTurn: boolean;
    startedAt: number;
    timeout: NodeJS.Timeout;
}

/**
 * Turn and compaction phases a maintenance window keeps out of Session state. Attention and identity signals still
 * pass: a permission prompt is real work, and a compaction may legitimately rebind the provider session.
 */
const ABSORBED_PHASES = new Set<AgentLifecycleSignal['phase']>([
    'compactionFinished',
    'compactionStarted',
    'turnFailed',
    'turnFinished',
    'turnStarted',
]);

/**
 * Keeps Server-initiated cache keep-alive compaction invisible. Both providers run `/compact` as an ordinary turn, so
 * without this a background keep-alive marked an idle Session running (the mobile Running group), lit the Desktop
 * sidebar's compacting spinner, and finished with an unread completion nobody asked for. A window covers exactly one
 * compaction turn on one Terminal; a user-initiated `/compact` never opens one and keeps its normal running state.
 */
export class AgentMaintenanceTurns {
    private readonly windows = new Map<string, MaintenanceWindow>();

    constructor(
        private readonly timeoutMs: number,
        private readonly logger: StructuredLogger,
        private readonly now: () => number = Date.now,
    ) {}

    begin(terminalId: string): void {
        this.end(terminalId, 'superseded');
        const timeout = setTimeout(() => this.end(terminalId, 'timeout'), this.timeoutMs);
        timeout.unref();
        this.windows.set(terminalId, {
            absorbed: 0,
            hasTurn: false,
            startedAt: this.now(),
            timeout,
        });
    }

    holds(terminalId: string): boolean {
        return this.windows.has(terminalId);
    }

    /**
     * Whether `signal` belongs to the open maintenance compaction and must not change Session state.
     */
    absorb(signal: AgentLifecycleSignal): boolean {
        const window = this.windows.get(signal.terminalId);
        if (!window || !ABSORBED_PHASES.has(signal.phase)) return false;
        if (signal.phase === 'turnStarted') {
            if (window.hasTurn) {
                this.end(signal.terminalId, 'nextTurn');
                return false;
            }
            window.hasTurn = true;
        }
        window.absorbed += 1;
        if (signal.phase === 'turnFinished' || signal.phase === 'turnFailed')
            this.end(signal.terminalId, 'turnFinished');
        // A PTY `/compact` may report only its compaction hooks and never a turn.
        else if (signal.phase === 'compactionFinished' && !window.hasTurn)
            this.end(signal.terminalId, 'compactionFinished');
        return true;
    }

    end(terminalId: string, reason: MaintenanceEndReason): void {
        const window = this.windows.get(terminalId);
        if (!window) return;
        clearTimeout(window.timeout);
        this.windows.delete(terminalId);
        this.logger.write('info', logEventCatalog.sessionCompaction.maintenanceEnded, {
            durationMs: this.now() - window.startedAt,
            fields: { terminalId, reason, absorbed: window.absorbed },
        });
    }

    clear(): void {
        for (const window of this.windows.values()) clearTimeout(window.timeout);
        this.windows.clear();
    }
}

import type { SessionCompactionResult, SessionInterruptCompactionResult } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

/**
 * How long the turns an interrupt reached get to settle before compacting. An interrupt lands within a second or two; a
 * provider that ignores it is closed after ten seconds (`AgentChatService.interrupt`).
 */
export const TURN_INTERRUPT_WAIT_MS = 15_000;
const TURN_POLL_MS = 1_000;

/**
 * Polls until none of `sessionIds` still runs a turn, the deadline passes, or `pause` resolves something other than
 * `'tick'` (Airplane Mode's skip). Shared by Airplane Mode and {@link SessionInterruptCompaction}.
 */
export async function waitForSettledTurns<Stop extends string>(options: {
    sessionIds: readonly string[];
    isTurnRunning(sessionId: string): boolean;
    deadlineAt: number;
    now(): number;
    pause(): Promise<'tick' | Stop>;
    shouldContinue?(): boolean;
}): Promise<'settled' | 'timedOut' | Stop> {
    for (;;) {
        if (options.shouldContinue && !options.shouldContinue()) return 'settled';
        if (options.sessionIds.every((sessionId) => !options.isTurnRunning(sessionId)))
            return 'settled';
        if (options.now() >= options.deadlineAt) return 'timedOut';
        // Polling: each pass depends on the previous one's answer.
        // oxlint-disable-next-line react-doctor/async-await-in-loop
        const outcome = await options.pause(); // eslint-disable-line no-await-in-loop -- see above
        if (outcome !== 'tick') return outcome;
    }
}

export function pollDelay(ms = TURN_POLL_MS): Promise<'tick'> {
    return new Promise<'tick'>((resolve) => {
        setTimeout(() => resolve('tick'), ms).unref();
    });
}

export interface SessionInterruptCompactionOptions {
    listSessionIds(): string[];
    /**
     * Whether the Session's primary Agent is running a turn now.
     */
    isTurnRunning(sessionId: string): boolean;
    /**
     * The same interrupt Airplane Mode sends: a Chat's Stop, or a standalone Escape to a PTY whose composer is provably
     * empty. Resolves `false` when the turn could not be interrupted safely; that turn keeps running.
     */
    interrupt(sessionId: string): Promise<boolean>;
    /**
     * The batch compaction (`session.compactWarm`).
     */
    compact(signal?: AbortSignal): Promise<SessionCompactionResult>;
    /**
     * Airplane Mode owns the Agents while it is on; this command refuses to run alongside it.
     */
    isAirplaneModeActive(): boolean;
    logger: StructuredLogger;
    now?: () => number;
    interruptWaitMs?: number;
    pollMs?: number;
}

/**
 * Interrupt and compact (docs/session-compaction.md#interrupt-and-compact): interrupts every running Agent turn, waits
 * for those turns to settle, then runs the batch compaction, which now finds them idle. Unlike Airplane Mode nothing
 * stops, and unlike idle compaction it does not wait for the prompt cache to near expiry. Interrupted Agents stay idle
 * until the user continues them.
 */
export class SessionInterruptCompaction {
    private running?: Promise<SessionInterruptCompactionResult>;

    constructor(private readonly options: SessionInterruptCompactionOptions) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private async runOnce(signal?: AbortSignal): Promise<SessionInterruptCompactionResult> {
        const startedAt = this.now();
        const working = this.options
            .listSessionIds()
            .filter((sessionId) => this.options.isTurnRunning(sessionId));
        const interrupted: string[] = [];
        await Promise.all(
            working.map(async (sessionId) => {
                try {
                    if (await this.options.interrupt(sessionId)) interrupted.push(sessionId);
                } catch {
                    // Uninterrupted, it keeps running and the batch reports it busy.
                }
            }),
        );
        const settled = await waitForSettledTurns({
            sessionIds: interrupted,
            isTurnRunning: (sessionId) => this.options.isTurnRunning(sessionId),
            deadlineAt: startedAt + (this.options.interruptWaitMs ?? TURN_INTERRUPT_WAIT_MS),
            now: () => this.now(),
            pause: () => pollDelay(this.options.pollMs),
            shouldContinue: () => !signal?.aborted,
        });
        signal?.throwIfAborted();
        const result = await this.options.compact(signal);
        this.options.logger.write('info', logEventCatalog.sessionCompaction.interrupted, {
            fields: {
                durationMs: this.now() - startedAt,
                workingCount: working.length,
                interruptedCount: interrupted.length,
                settled: settled === 'settled',
                submittedCount: result.items.filter(({ outcome }) => outcome === 'submitted')
                    .length,
            },
        });
        return { ...result, interrupted: interrupted.length };
    }

    async run(signal?: AbortSignal): Promise<SessionInterruptCompactionResult> {
        if (this.options.isAirplaneModeActive())
            throw new CaxriError('CONFLICT', 'Airplane Mode is managing the Agents');
        if (this.running) return this.running;
        this.running = this.runOnce(signal);
        try {
            return await this.running;
        } finally {
            this.running = undefined;
        }
    }
}

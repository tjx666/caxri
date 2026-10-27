import type {
    AirplaneModePhase,
    AirplaneModeState,
    SessionCompactionResult,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { CaxriDatabase } from '../db';

/**
 * How long entering waits for the compactions it submitted before parking anyway. A native compaction of a large
 * conversation usually finishes within a minute or two; the user can also skip the wait from the dialog.
 */
const AIRPLANE_MODE_COMPACTION_WAIT_MS = 3 * 60_000;
const COMPACTION_POLL_MS = 1_000;

/**
 * Why a phase changed, logged with every transition.
 */
type TransitionReason =
    | 'compactionFailed'
    | 'compactionFinished'
    | 'compactionSkipped'
    | 'compactionTimedOut'
    | 'entered'
    | 'exited'
    | 'parked'
    | 'resumed'
    | 'serverRestarted';

export interface AirplaneModeOptions {
    database: Pick<CaxriDatabase, 'getAppState' | 'getSession' | 'listSessions' | 'setAppState'>;
    /**
     * The batch compaction (`session.compactWarm`): only idle Sessions whose prompt cache is still warm are submitted.
     */
    compact(): Promise<SessionCompactionResult>;
    /**
     * Whether the maintenance compaction submitted to this Terminal is still running.
     */
    isCompacting(terminalId: string): boolean;
    hasLiveAgent(sessionId: string): boolean;
    /**
     * Stops the Session's Agents as `detached` (`detachSessionAgents`).
     */
    detach(sessionId: string): Promise<void>;
    /**
     * Relaunches the Session's detached Agents on their bound conversations, resolving once its PTY restores settled.
     */
    resume(sessionId: string): Promise<void>;
    publish(state: AirplaneModeState): void;
    logger: StructuredLogger;
    now?: () => number;
    compactionWaitMs?: number;
    pollMs?: number;
}

const OFF: AirplaneModeState = { phase: 'off', parkedSessionIds: [] };

/**
 * Whether Agent launches must stay down. The compaction wait still needs its Agents, and resuming relaunches them.
 * Takes the durable state so the Chat service can consult it without holding the Airplane Mode service.
 */
export function isAirplaneModeHolding(
    state: Pick<AirplaneModeState, 'phase'> | undefined,
): boolean {
    return state?.phase === 'parking' || state?.phase === 'on';
}

/**
 * Airplane Mode: before the user goes offline, compact the conversations worth compacting, then stop every Agent so no
 * CLI keeps retrying requests without a network, and hold them stopped until the user picks which Sessions to resume.
 *
 * Parking reuses `session.detach`: a detached Agent keeps its record and bound conversation and is not relaunched by
 * selecting its Session. While parking or on, {@link holds} is the fence the Terminal suspension service and the Chat
 * service consult, so an Agent launch from any path (a dispatch, Caxri Bot, a restart) is parked or refused. The state
 * is durable so the dialog and the parked list survive a restart.
 */
export class AirplaneMode {
    private state: AirplaneModeState;
    private phaseStartedAt: number;
    private skipWait?: () => void;
    private isClosed = false;
    /**
     * Counts entries, so a compaction wait that outlived its own cancel cannot park a later entry.
     */
    private entry = 0;

    constructor(private readonly options: AirplaneModeOptions) {
        const stored = options.database.getAppState('airplaneMode');
        this.state = stored ? { ...stored } : OFF;
        this.phaseStartedAt = this.now();
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private isCurrentEntry(entry: number): boolean {
        return !this.isClosed && this.entry === entry && this.state.phase === 'compacting';
    }

    private async compactThenPark(entry: number): Promise<void> {
        const skipped = new Promise<'skipped'>((resolve) => {
            this.skipWait = () => resolve('skipped');
        });
        try {
            let result: SessionCompactionResult | 'failed' | 'skipped';
            try {
                result = await Promise.race([this.options.compact(), skipped]);
            } catch {
                result = 'failed';
            }
            let reason: TransitionReason;
            if (result === 'skipped') reason = 'compactionSkipped';
            else if (result === 'failed') reason = 'compactionFailed';
            else reason = await this.waitForCompactions(entry, result, skipped);
            if (!this.isCurrentEntry(entry)) return;
            await this.park(reason);
        } finally {
            this.skipWait = undefined;
        }
    }

    private async waitForCompactions(
        entry: number,
        result: SessionCompactionResult,
        skipped: Promise<'skipped'>,
    ): Promise<TransitionReason> {
        const terminalIds = result.items.flatMap(({ outcome, sessionId }) => {
            if (outcome !== 'submitted' && outcome !== 'delivery_unknown') return [];
            const terminalId = this.options.database.getSession(sessionId)?.primaryAgentTerminalId;
            return terminalId ? [terminalId] : [];
        });
        const deadlineAt =
            this.now() + (this.options.compactionWaitMs ?? AIRPLANE_MODE_COMPACTION_WAIT_MS);
        for (;;) {
            if (!this.isCurrentEntry(entry)) return 'compactionSkipped';
            const pending = terminalIds.filter((id) => this.options.isCompacting(id)).length;
            const compaction = { submitted: terminalIds.length, pending, deadlineAt };
            const previous = this.state.compaction;
            if (previous?.pending !== pending || previous.submitted !== compaction.submitted)
                this.update({ compaction }, false);
            if (pending === 0) return 'compactionFinished';
            if (this.now() >= deadlineAt) return 'compactionTimedOut';
            const tick = new Promise<'tick'>((resolve) => {
                setTimeout(
                    () => resolve('tick'),
                    this.options.pollMs ?? COMPACTION_POLL_MS,
                ).unref();
            });
            // Polling: each pass depends on the previous one's answer.
            // oxlint-disable-next-line react-doctor/async-await-in-loop
            const outcome = await Promise.race([skipped, tick]); // eslint-disable-line no-await-in-loop -- see above
            if (outcome === 'skipped') return 'compactionSkipped';
        }
    }

    private async park(reason: TransitionReason): Promise<void> {
        this.transition('parking', reason);
        const live = this.options.database
            .listSessions()
            .filter((session) => this.options.hasLiveAgent(session.id))
            .map((session) => session.id);
        let failed = 0;
        await Promise.all(
            live.map(async (sessionId) => {
                try {
                    await this.options.detach(sessionId);
                } catch {
                    failed += 1;
                }
            }),
        );
        const parked = new Set([...this.state.parkedSessionIds, ...live]);
        this.transition('on', 'parked', { parkedSessionIds: [...parked] }, { failed });
    }

    private async resume(sessionIds: readonly string[]): Promise<void> {
        let failed = 0;
        for (const sessionId of sessionIds) {
            if (this.isClosed) return;
            try {
                // One Session at a time: the restore supervisor serves a single Session and aborts the previous one.
                // oxlint-disable-next-line react-doctor/async-await-in-loop
                await this.options.resume(sessionId); // eslint-disable-line no-await-in-loop -- see above
            } catch {
                failed += 1;
            }
        }
        this.transition('off', 'resumed', {}, { failed, resumed: sessionIds.length });
    }

    private transition(
        phase: AirplaneModePhase,
        reason: TransitionReason,
        patch: Partial<AirplaneModeState> = {},
        counts: Record<string, number> = {},
    ): void {
        const previous = this.state.phase;
        const now = this.now();
        this.options.logger.write('info', logEventCatalog.sessionAirplaneMode.changed, {
            fields: {
                durationMs: now - this.phaseStartedAt,
                parkedCount: patch.parkedSessionIds?.length ?? this.state.parkedSessionIds.length,
                phase,
                previousPhase: previous,
                reason,
                submittedCount: this.state.compaction?.submitted ?? null,
                pendingCount: this.state.compaction?.pending ?? null,
                ...counts,
            },
        });
        this.phaseStartedAt = now;
        this.update(phase === 'off' ? OFF : { ...this.state, ...patch, phase });
    }

    private update(patch: Partial<AirplaneModeState>, shouldPersist = true): void {
        const next: AirplaneModeState = { ...this.state, ...patch };
        if (next.phase === 'off') delete next.enteredAt;
        if (next.phase !== 'compacting') delete next.compaction;
        this.state = next;
        if (shouldPersist) {
            const { enteredAt, parkedSessionIds, phase } = next;
            this.options.database.setAppState('airplaneMode', {
                enteredAt,
                parkedSessionIds,
                phase,
            });
        }
        this.options.publish(next);
    }

    /**
     * Finishes what a previous Server Core left unfinished. Its Agents died with it, so an interrupted entry only has
     * to finish parking (a restore that lands is caught by the fence), and an interrupted resume is over: Sessions it
     * had not reached stay detached and resume individually.
     */
    start(): void {
        if (this.state.phase === 'compacting' || this.state.phase === 'parking')
            void this.park('serverRestarted');
        else if (this.state.phase === 'resuming') this.transition('off', 'serverRestarted');
    }

    holds(): boolean {
        return isAirplaneModeHolding(this.state);
    }

    status(): AirplaneModeState {
        return this.state;
    }

    enter(): AirplaneModeState {
        if (this.state.phase !== 'off') return this.state;
        this.transition('compacting', 'entered', { enteredAt: this.now(), parkedSessionIds: [] });
        this.entry += 1;
        void this.compactThenPark(this.entry);
        return this.state;
    }

    skipCompaction(): AirplaneModeState {
        this.skipWait?.();
        return this.state;
    }

    /**
     * Leaving while the compaction wait still runs cancels Airplane Mode without stopping anything. Otherwise the
     * picked Sessions relaunch one at a time in the background (each restore owns its Session, see
     * `TerminalRestoreSupervisor`) and the phase returns to `off` once they all settled.
     */
    exit(sessionIds: readonly string[]): AirplaneModeState {
        const { phase, parkedSessionIds } = this.state;
        if (phase === 'off' || phase === 'resuming') return this.state;
        if (phase === 'parking')
            throw new CaxriError('CONFLICT', 'Airplane Mode is still stopping Agents');
        if (phase === 'compacting') {
            this.transition('off', 'exited');
            this.skipWait?.();
            return this.state;
        }
        const picked = [...new Set(sessionIds).intersection(new Set(parkedSessionIds))];
        this.transition('resuming', 'exited');
        void this.resume(picked);
        return this.state;
    }

    /**
     * An Agent launch the fence parked: its Session joins the resumable list.
     */
    noteParked(sessionId: string): void {
        if (!this.holds() || this.state.parkedSessionIds.includes(sessionId)) return;
        this.update({ parkedSessionIds: [...this.state.parkedSessionIds, sessionId] });
    }

    close(): void {
        this.isClosed = true;
        this.skipWait?.();
    }
}

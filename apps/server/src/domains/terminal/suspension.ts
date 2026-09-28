import type { AppSettings, ServerEvent, TerminalRecord } from '@caxri/protocol';
import { errorMessage } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { AgentLifecycleSignal } from '../agents';
import type { CaxriDatabase } from '../db';
import type { WatchHandle, WatchHub } from '../watch-hub';
import type { TerminalManager } from './manager';
import type { TerminalActivitySample, TerminalSuspensionReason } from './suspension-policy';
import { decideTerminalSuspensions } from './suspension-policy';

const TERMINAL_SUSPENSION_SWEEP_INTERVAL_MS = 15_000;

interface TerminalSuspensionServiceOptions {
    database: CaxriDatabase;
    logger: StructuredLogger;
    now?: () => number;
    /**
     * Reconciles a Terminal that finished an automatic (`idle`/`untouched`) suspend while its Session was, or had just
     * become, the selected one — see the race explained on `suspendTerminal`. The caller is expected to wire this to
     * the same restore `session.select` triggers (e.g. `restoreInterruptedTerminalsInBackground`), so the Terminal
     * converges back to running without the user having to reselect.
     */
    onSuspendedSessionReselected?: (sessionId: string) => void;
    selectedSessionId: () => string | undefined;
    send: (event: ServerEvent) => void;
    settings: () => AppSettings;
    sweepIntervalMs?: number;
    terminals: Pick<TerminalManager, 'processId' | 'suspend'>;
    watchHub: Pick<WatchHub, 'registerPoller'>;
}

/**
 * Parks background Agent Terminals that nobody is using so an idle workspace stops paying for a dozen resident CLIs.
 * Activity is tracked in memory only (launch, input, lifecycle turns, Session selection); a suspended Terminal keeps
 * its record, scrollback, and Agent session, and the ordinary interrupted-restore path relaunches it on selection.
 */
export class TerminalSuspensionService {
    private readonly deselectedAt = new Map<string, number>();
    private readonly samples = new Map<string, TerminalActivitySample>();
    private readonly startedAt: number;
    private lastSelectedSessionId: string | undefined;
    private poller: WatchHandle | undefined;
    private sweeping: Promise<string[]> | undefined;

    constructor(private readonly options: TerminalSuspensionServiceOptions) {
        this.startedAt = this.now();
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private sample(terminalId: string): TerminalActivitySample {
        const existing = this.samples.get(terminalId);
        if (existing) return existing;
        const created: TerminalActivitySample = { turnInFlight: false };
        this.samples.set(terminalId, created);
        return created;
    }

    private async runSweep(): Promise<string[]> {
        try {
            return await this.suspendDecided();
        } finally {
            this.sweeping = undefined;
        }
    }

    private async suspendDecided(): Promise<string[]> {
        const { database } = this.options;
        this.observeSelection();
        /**
         * The Agent Commander's Session is never selected in the Workbench, so without this exemption it would always
         * look abandoned; its Terminal is supervised by its own window instead.
         */
        const commanderSessionId = database.agentCommanderRows()?.sessionId;
        const decisions = decideTerminalSuspensions({
            deselectedAt: (sessionId) => this.deselectedAt.get(sessionId),
            now: this.now(),
            sample: (terminalId) => this.samples.get(terminalId),
            selectedSessionId: this.options.selectedSessionId(),
            session: (sessionId) => database.getSession(sessionId) ?? undefined,
            settings: this.options.settings(),
            startedAt: this.startedAt,
            terminals: database
                .listTerminals()
                .filter((terminal) => terminal.sessionId !== commanderSessionId),
        });
        const suspended: string[] = [];
        // Suspensions run one at a time so each restart barrier and snapshot capture finishes before the next kill.
        for (const decision of decisions)
            // eslint-disable-next-line no-await-in-loop -- sequential teardown, see comment above
            if (await this.suspendTerminal(decision.terminalId, decision.reason))
                suspended.push(decision.terminalId);
        this.publish(suspended);
        return suspended;
    }

    /**
     * `decideTerminalSuspensions` (called from `suspendDecided`) snapshots the selected Session once at the top of the
     * sweep, but the teardown below is a real async barrier (`TerminalManager#suspend` awaits killing the PTY and
     * capturing its final screen). A `session.select` that lands anywhere in that window — before this call starts, or
     * while it is in flight — is invisible to the snapshot, so without this fence the just-selected Session's Terminal
     * would end up `suspended` with nothing left to retry it (GitHub issue #1427). `archived`/`detached` are explicit
     * user actions on a specific Session and must proceed regardless of what is selected, so only the automatic
     * `idle`/`untouched` reasons are fenced.
     */
    private async suspendTerminal(
        terminalId: string,
        reason: TerminalSuspensionReason | 'archived' | 'detached',
    ): Promise<boolean> {
        const isAutomaticSweep = reason === 'idle' || reason === 'untouched';
        // Closes the gap between one decision's teardown and the next: skip outright if the selection already
        // changed before this Terminal's own teardown even started.
        if (
            isAutomaticSweep &&
            this.options.selectedSessionId() ===
                this.options.database.getTerminal(terminalId)?.sessionId
        )
            return false;
        try {
            const record = await this.options.terminals.suspend(
                terminalId,
                reason === 'detached' ? 'detached' : 'suspended',
                reason === 'archived'
                    ? 'sessionArchived'
                    : reason === 'idle'
                      ? 'idleSuspended'
                      : reason === 'untouched'
                        ? 'untouchedSuspended'
                        : undefined,
            );
            if (!record) return false;
            this.samples.delete(terminalId);
            this.options.logger.write('info', logEventCatalog.terminal.suspended, {
                fields: { reason, sessionId: record.sessionId, terminalId },
            });
            // Closes the narrower gap: the selection changed while this Terminal's own teardown was in flight, so
            // the kill already happened and the record is genuinely `suspended` — reconcile it back to running.
            if (isAutomaticSweep && this.options.selectedSessionId() === record.sessionId)
                this.options.onSuspendedSessionReselected?.(record.sessionId);
            return true;
        } catch (error) {
            this.options.logger.write('warn', logEventCatalog.terminal.suspendFailed, {
                fields: { error: errorMessage(error, 'unknown'), reason, terminalId },
            });
            return false;
        }
    }

    private publish(terminalIds: readonly string[]): void {
        if (terminalIds.length === 0) return;
        this.options.send({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [], terminalIds: [...terminalIds] },
        });
    }

    private async parkSession(
        sessionId: string,
        reason: 'archived' | 'detached',
        isEligible: (terminal: TerminalRecord) => boolean,
    ): Promise<string[]> {
        const parked: string[] = [];
        for (const terminal of this.options.database.listTerminals(sessionId)) {
            if (
                !isEligible(terminal) ||
                this.options.terminals.processId(terminal.id) === undefined
            )
                continue;
            // Sequential teardown, same as the sweep: each restart barrier and snapshot capture finishes first.
            // oxlint-disable-next-line react-doctor/async-await-in-loop
            const suspended = await this.suspendTerminal(terminal.id, reason); // eslint-disable-line no-await-in-loop -- see above
            if (suspended) parked.push(terminal.id);
        }
        this.publish(parked);
        return parked;
    }

    /**
     * Wires the reselection-recovery callback after construction: the caller's
     * `restoreInterruptedTerminalsInBackground` does not exist yet when this service is constructed (it depends on the
     * Terminal restore supervisor, created afterward), so the constructor option alone cannot reach it. See
     * `onSuspendedSessionReselected`'s own doc comment.
     */
    setOnSuspendedSessionReselected(
        onSuspendedSessionReselected: (sessionId: string) => void,
    ): void {
        this.options.onSuspendedSessionReselected = onSuspendedSessionReselected;
    }

    /**
     * Sessions that are not selected at startup are treated as deselected now, so a Server restart never suspends on
     * the strength of a selection change it did not observe.
     */
    start(): void {
        const selected = this.options.selectedSessionId();
        const now = this.now();
        this.lastSelectedSessionId = selected;
        for (const session of this.options.database.listSessions())
            if (session.id !== selected) this.deselectedAt.set(session.id, now);
        this.poller = this.options.watchHub.registerPoller({
            intervalMs: this.options.sweepIntervalMs ?? TERMINAL_SUSPENSION_SWEEP_INTERVAL_MS,
            label: 'terminal-suspension',
            pollOnce: async () => {
                await this.sweep();
            },
        });
    }

    observeLaunch(terminalId: string): void {
        this.samples.set(terminalId, { launchedAt: this.now(), turnInFlight: false });
    }

    observeInput(terminalId: string): void {
        this.sample(terminalId).lastInputAt = this.now();
    }

    observeLifecycle(signal: Pick<AgentLifecycleSignal, 'phase' | 'terminalId'>): void {
        const sample = this.sample(signal.terminalId);
        const now = this.now();
        switch (signal.phase) {
            case 'turnStarted':
                sample.lastTurnStartedAt = now;
                sample.turnInFlight = true;
                return;
            case 'turnFinished':
            case 'turnFailed':
            case 'attentionRequested':
                sample.lastTurnFinishedAt = now;
                sample.turnInFlight = false;
                return;
            default:
                return;
        }
    }

    /**
     * Re-reads the selected Session and stamps the one that was just left. Called after every selection change and at
     * the top of each sweep, so a selection that changed through another path is still noticed within one interval.
     */
    observeSelection(): void {
        const selected = this.options.selectedSessionId();
        if (selected === this.lastSelectedSessionId) return;
        if (this.lastSelectedSessionId !== undefined)
            this.deselectedAt.set(this.lastSelectedSessionId, this.now());
        if (selected !== undefined) this.deselectedAt.delete(selected);
        this.lastSelectedSessionId = selected;
    }

    forgetTerminal(terminalId: string): void {
        this.samples.delete(terminalId);
    }

    forgetSession(sessionId: string): void {
        this.deselectedAt.delete(sessionId);
    }

    /**
     * Evaluates the policy once and suspends every decided Terminal. Concurrent callers share one pass.
     */
    sweep(): Promise<string[]> {
        this.sweeping ??= this.runSweep();
        return this.sweeping;
    }

    /**
     * An archived Session has no viewer; every live Terminal in it is parked and resumes when it is selected again.
     */
    suspendSession(sessionId: string): Promise<string[]> {
        return this.parkSession(sessionId, 'archived', () => true);
    }

    /**
     * Parks every live Agent Terminal of a Session as `detached` so another client can resume the same provider
     * conversation (Codex refuses to open one session twice). Shell tabs stay untouched: the user only wants to hand
     * over the Agent, not their shell. Unlike archive/idle suspension, selecting the Session does not relaunch these.
     */
    detachSession(sessionId: string): Promise<string[]> {
        return this.parkSession(
            sessionId,
            'detached',
            (terminal) => terminal.provider !== undefined,
        );
    }

    async close(): Promise<void> {
        await this.poller?.dispose();
        this.poller = undefined;
    }
}

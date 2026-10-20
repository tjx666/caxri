import type { AppSettings, ServerEvent, TerminalRecord } from '@caxri/protocol';
import { errorMessage } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { AgentLifecycleSignal } from '../agents';
import { isLateMidTurnSignalAfterInterrupt, isMidTurnSignal, isStandaloneEscape } from '../agents';
import type { CaxriDatabase } from '../db';
import { agentCommanderIdentity } from '../db';
import { isPtyTerminal } from '../pty-guard';
import type { WatchHandle, WatchHub } from '../watch';
import type { TerminalExecutionPort } from './execution-port';
import type { TerminalManager } from './manager';
import type { TerminalLifecycleCause } from './manager-types';
import type { TerminalActivitySample, TerminalSuspensionReason } from './suspension-policy';
import { decideTerminalSuspensions, lastActiveAt } from './suspension-policy';

const TERMINAL_SUSPENSION_SWEEP_INTERVAL_MS = 15_000;

type ParkReason = TerminalSuspensionReason | 'archived' | 'detached' | 'requested' | 'terminated';

/**
 * Why a resumed Terminal was parked: the park reason this process recorded, or `beforeRestart` for a Terminal an
 * earlier Server Core left `suspended` or `detached`, whose reason and park time died with that process.
 */
type ResumeReason = ParkReason | 'beforeRestart';

/**
 * The durable states a later Agent launch resumes from; `stopped` is final and never restored.
 */
const PARKED_STATES: ReadonlySet<TerminalRecord['lastProcessState']> = new Set([
    'detached',
    'suspended',
]);

/**
 * The durable state and lifecycle cause each park writes. Only a terminate is final: `stopped` is never restored, while
 * `suspended` resumes on selection and `detached` on `session.resume`.
 */
const PARKED_AS: Record<
    ParkReason,
    { state: 'detached' | 'stopped' | 'suspended'; cause?: TerminalLifecycleCause }
> = {
    archived: { state: 'suspended', cause: 'sessionArchived' },
    detached: { state: 'detached' },
    idle: { state: 'suspended', cause: 'idleSuspended' },
    requested: { state: 'suspended' },
    terminated: { state: 'stopped', cause: 'userTerminated' },
    untouched: { state: 'suspended', cause: 'untouchedSuspended' },
};

interface TerminalSuspensionServiceOptions {
    database: CaxriDatabase;
    logger: StructuredLogger;
    now?: () => number;
    /**
     * Reconciles a Terminal that finished an automatic (`idle`/`untouched`) suspend while its Session was, or had just
     * become, the selected one: see the race explained on `suspendTerminal`. The caller is expected to wire this to the
     * same restore `session.select` triggers (e.g. `restoreInterruptedTerminalsInBackground`), so the Terminal
     * converges back to running without the user having to reselect.
     */
    onSuspendedSessionReselected?: (sessionId: string) => void;
    selectedSessionId: () => string | undefined;
    send: (event: ServerEvent) => void;
    settings: () => AppSettings;
    sweepIntervalMs?: number;
    /**
     * Every record of a phone watching a Terminal: its screen through the execution port, and its Conversation through
     * the transcript watcher. Any one of them counts the Terminal as viewed.
     */
    remoteObservers: ReadonlyArray<Pick<TerminalExecutionPort, 'isObservedRemotely'>>;
    terminals: Pick<TerminalManager, 'processId' | 'settleLaunches' | 'suspend'>;
    /**
     * Agent Chats, which park by stopping their provider process (see `AgentChatService.suspendIdle`).
     */
    chats?: {
        isSuspendable(terminalId: string): boolean;
        suspendIdle(terminalId: string): Promise<TerminalRecord | undefined>;
    };
    watchHub: Pick<WatchHub, 'registerPoller'>;
}

/**
 * Parks background Agent Terminals that nobody is using so an idle workspace stops paying for a dozen resident CLIs.
 * Activity is tracked in memory only (launch, input, lifecycle turns, Session selection); a suspended Terminal keeps
 * its record, scrollback, and Agent session, and the ordinary interrupted-restore path relaunches it on selection.
 */
export class TerminalSuspensionService {
    private readonly deselectedAt = new Map<string, number>();
    /**
     * Sessions whose `session.detach` is running. An Agent launch of theirs that lands meanwhile is handed over too.
     */
    private readonly detaching = new Set<string>();
    /**
     * `terminateAll` calls still running; every launch that lands meanwhile is stopped too.
     */
    private terminating = 0;
    /**
     * `parkLaunch` teardowns in flight. A Session park that reaches the same Terminal joins one instead of sending a
     * second Host stop for a process whose first stop is still pending.
     */
    private readonly launchParkings = new Map<string, Promise<boolean>>();
    private readonly samples = new Map<string, TerminalActivitySample>();
    /**
     * Terminals parked in a resumable state, with why and when, so the launch that resumes one can log how long it
     * stayed parked. In memory only, so `start` seeds an Agent an earlier Server Core left `suspended` with no time.
     */
    private readonly parked = new Map<string, { at?: number; reason: ResumeReason }>();
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
        const commanderSessionId = agentCommanderIdentity(database)?.sessionId;
        for (const terminalId of this.parked.keys())
            if (!database.getTerminal(terminalId)) this.parked.delete(terminalId);
        const decisions = decideTerminalSuspensions({
            deselectedAt: (sessionId) => this.deselectedAt.get(sessionId),
            isChatSuspendable: (terminalId) =>
                this.options.chats?.isSuspendable(terminalId) ?? false,
            isObservedRemotely: (terminalId) =>
                this.options.remoteObservers.some((source) =>
                    source.isObservedRemotely(terminalId),
                ),
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
     * capturing its final screen). A `session.select` that lands anywhere in that window (before this call starts, or
     * while it is in flight) is invisible to the snapshot, so without this fence the just-selected Session's Terminal
     * would end up `suspended` with nothing left to retry it (GitHub issue #1427). `archived`/`detached` are explicit
     * user actions on a specific Session and must proceed regardless of what is selected, so only the automatic
     * `idle`/`untouched` reasons are fenced.
     */
    private async suspendTerminal(terminalId: string, reason: ParkReason): Promise<boolean> {
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
            const { cause, state } = PARKED_AS[reason];
            const metrics = this.parkMetrics(terminalId, reason);
            const terminal = this.options.database.getTerminal(terminalId);
            // Only the automatic sweep decides a Chat; explicit parks reach PTYs only (see `park`).
            const record =
                terminal && !isPtyTerminal(terminal)
                    ? await this.options.chats?.suspendIdle(terminalId)
                    : await this.options.terminals.suspend(terminalId, state, cause);
            if (!record) return false;
            this.samples.delete(terminalId);
            // Only an Agent comes back through `observeLaunch`; a parked Shell would linger and mislabel a later launch.
            if (state === 'stopped' || !record.provider) this.parked.delete(terminalId);
            else this.parked.set(terminalId, { at: this.now(), reason });
            this.options.logger.write('info', logEventCatalog.terminal.suspended, {
                fields: {
                    ...metrics,
                    provider: record.provider ?? null,
                    reason,
                    sessionId: record.sessionId,
                    terminalId,
                },
            });
            // Closes the narrower gap: the selection changed while this Terminal's own teardown was in flight, so
            // the kill already happened and the record is genuinely `suspended`: reconcile it back to running.
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

    /**
     * Durations an automatic park is judged on, captured before teardown discards the activity sample: how long the
     * Agent showed no activity and how long its Session had been unselected. Explicit parks carry neither.
     */
    private parkMetrics(
        terminalId: string,
        reason: ParkReason,
    ): { backgroundMs?: number; idleMs?: number } {
        if (reason !== 'idle' && reason !== 'untouched') return {};
        const now = this.now();
        const sessionId = this.options.database.getTerminal(terminalId)?.sessionId;
        const deselectedAt = sessionId === undefined ? undefined : this.deselectedAt.get(sessionId);
        return {
            idleMs: now - lastActiveAt(this.samples.get(terminalId), this.startedAt),
            ...(deselectedAt !== undefined && { backgroundMs: now - deselectedAt }),
        };
    }

    private publish(terminalIds: readonly string[]): void {
        if (terminalIds.length === 0) return;
        this.options.send({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [], terminalIds: [...terminalIds] },
        });
    }

    /**
     * Parks one live PTY, joining a `parkLaunch` teardown already running for it. False when nothing was live.
     */
    private park(terminal: TerminalRecord, reason: ParkReason): Promise<boolean> {
        const launchParking = this.launchParkings.get(terminal.id);
        if (launchParking) return launchParking;
        if (!isPtyTerminal(terminal) || this.options.terminals.processId(terminal.id) === undefined)
            return Promise.resolve(false);
        return this.suspendTerminal(terminal.id, reason);
    }

    private async parkSession(
        sessionId: string,
        reason: 'archived' | 'detached',
        isEligible: (terminal: TerminalRecord) => boolean,
    ): Promise<string[]> {
        const parked: string[] = [];
        for (const terminal of this.options.database.listTerminals(sessionId)) {
            if (!isEligible(terminal)) continue;
            // Sequential teardown, same as the sweep: each restart barrier and snapshot capture finishes first.
            // oxlint-disable-next-line react-doctor/async-await-in-loop
            if (await this.park(terminal, reason)) parked.push(terminal.id); // eslint-disable-line no-await-in-loop -- see above
        }
        this.publish(parked);
        return parked;
    }

    /**
     * The park a launch that just landed still owes: a running `terminateAll` stops it, a running detach of its Session
     * hands over its Agent, and a Session that left the Workbench (archived, or its Project hidden) parks it.
     */
    private launchParkReason(record: TerminalRecord): ParkReason | undefined {
        if (this.terminating > 0) return 'terminated';
        if (record.provider !== undefined && this.detaching.has(record.sessionId))
            return 'detached';
        const { database } = this.options;
        const session = database.getSession(record.sessionId);
        if (!session) return undefined;
        return session.archivedAt !== undefined ||
            database.getProject(session.projectId)?.hiddenAt !== undefined
            ? 'archived'
            : undefined;
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
     * the strength of a selection change it did not observe. An Agent still `suspended` or `detached` was parked by an
     * earlier Server Core; it is seeded as parked without a time so its resume is still counted (GitHub issue #1784).
     */
    start(): void {
        const selected = this.options.selectedSessionId();
        const now = this.now();
        this.lastSelectedSessionId = selected;
        for (const session of this.options.database.listSessions())
            if (session.id !== selected) this.deselectedAt.set(session.id, now);
        for (const terminal of this.options.database.listTerminals())
            if (terminal.provider && PARKED_STATES.has(terminal.lastProcessState))
                this.parked.set(terminal.id, { reason: 'beforeRestart' });
        this.poller = this.options.watchHub.registerPoller({
            intervalMs: this.options.sweepIntervalMs ?? TERMINAL_SUSPENSION_SWEEP_INTERVAL_MS,
            label: 'terminal-suspension',
            pollOnce: async () => {
                await this.sweep();
            },
        });
    }

    /**
     * A new Agent launch. When the Terminal was parked, the launch is its resume (Session selection, `session.resume`,
     * or a manual restart), and the time it spent parked is logged against the original reason; `null` when an earlier
     * Server Core parked it.
     */
    observeLaunch(terminalId: string): void {
        const now = this.now();
        this.samples.set(terminalId, { launchedAt: now, turnInFlight: false });
        const parked = this.parked.get(terminalId);
        if (!parked) return;
        this.parked.delete(terminalId);
        const record = this.options.database.getTerminal(terminalId);
        this.options.logger.write('info', logEventCatalog.terminal.resumed, {
            fields: {
                provider: record?.provider ?? null,
                reason: parked.reason,
                sessionId: record?.sessionId ?? null,
                suspendedForMs: parked.at === undefined ? null : now - parked.at,
                terminalId,
            },
        });
    }

    /**
     * Core-delivered input. A standalone Escape is the user interrupting the Agent, which ends its turn and any prompt
     * without a completion hook (Claude sends no `Stop` for an interrupted turn), so it clears both holds the way the
     * coordinator's own interrupt handling does.
     */
    observeInput(terminalId: string, data: string): void {
        const sample = this.sample(terminalId);
        sample.lastInputAt = this.now();
        if (!isStandaloneEscape(data)) return;
        this.observeInterrupt(terminalId);
    }

    /**
     * The Agent's turn was interrupted: a standalone Escape, or an Agent Endpoint `SIGINT`. Clears the in-flight and
     * awaiting-user holds and stamps the interrupt so a hook the provider emitted just before it, delivered just after,
     * does not reopen the turn (see `isLateMidTurnSignalAfterInterrupt`).
     */
    observeInterrupt(terminalId: string): void {
        const sample = this.sample(terminalId);
        sample.turnInFlight = false;
        sample.awaitingUser = false;
        sample.interruptedAt = this.now();
    }

    /**
     * Folds one accepted raw lifecycle signal into the launch's activity. Every phase counts as activity. A main-scope
     * `turnStarted` opens the turn; an attention request holds the Agent awaiting the user until the coordinator
     * accepts its resolution or the turn starts, ends, or is interrupted. A raw completion does not end the turn: the
     * coordinator may defer a parent `Stop` until its background subagents finish, so only `observeAppliedLifecycle`
     * closes it. A subagent-scoped signal (`agentId` set) never starts the main turn.
     *
     * A main-scope mid-turn signal (`isMidTurnSignal`) reopens the turn: `observeInput` takes every standalone Escape
     * as an interrupt, so without this an Escape that only closed a picker would leave a running turn guarded by the
     * idle clock alone (GitHub issue #1785). One arriving within a short window after the interrupt is that turn's own
     * late hook and does not reopen it (GitHub issue #1819).
     */
    observeLifecycle(signal: Pick<AgentLifecycleSignal, 'agentId' | 'phase' | 'terminalId'>): void {
        const sample = this.sample(signal.terminalId);
        const now = this.now();
        sample.lastSignalAt = now;
        if (
            isMidTurnSignal(signal) &&
            !isLateMidTurnSignalAfterInterrupt(signal, sample.interruptedAt, now)
        )
            sample.turnInFlight = true;
        const isMainScope = signal.agentId === undefined;
        switch (signal.phase) {
            case 'turnStarted':
                if (!isMainScope) return;
                sample.lastTurnStartedAt = now;
                sample.turnInFlight = true;
                sample.awaitingUser = false;
                return;
            case 'attentionRequested':
                sample.awaitingUser = true;
                return;
            case 'attentionResolved':
            case 'toolBatchFinished':
                sample.awaitingUser = false;
                return;
            default:
                return;
        }
    }

    /**
     * A lifecycle transition the coordinator applied: the authority for a turn's end, including a deferred parent
     * completion and one reconciled from provider metadata after its hook was lost.
     */
    observeAppliedLifecycle(
        signal: Pick<AgentLifecycleSignal, 'agentId' | 'phase' | 'terminalId'>,
    ): void {
        if (signal.agentId !== undefined) return;
        if (signal.phase !== 'turnFinished' && signal.phase !== 'turnFailed') return;
        const sample = this.sample(signal.terminalId);
        const now = this.now();
        sample.lastSignalAt = now;
        sample.lastTurnFinishedAt = now;
        sample.turnInFlight = false;
        sample.awaitingUser = false;
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
     * Parks one Terminal because the user asked to stop it: the resource alert's `Stop`. It resumes through the same
     * interrupted-restore path as an idle suspension, so the Agent conversation is not lost.
     */
    async suspendOnRequest(terminalId: string): Promise<boolean> {
        if (this.options.terminals.processId(terminalId) === undefined) return false;
        const suspended = await this.suspendTerminal(terminalId, 'requested');
        if (suspended) this.publish([terminalId]);
        return suspended;
    }

    /**
     * Parks a PTY whose launch completed after its Session left the Workbench (archived, or its Project hidden), or
     * while a `session.detach` or `terminateAll` that covers it was running. Those actions park only Terminals that
     * already have a process, and a Host start still in flight had none, so without this the PTY keeps running unseen,
     * counted by the close prompt, with nothing left that would ever suspend it.
     */
    async parkLaunch(record: TerminalRecord): Promise<void> {
        const reason = this.launchParkReason(record);
        if (!reason) return;
        const parking = this.suspendTerminal(record.id, reason);
        this.launchParkings.set(record.id, parking);
        try {
            if (await parking) this.publish([record.id]);
        } finally {
            if (this.launchParkings.get(record.id) === parking)
                this.launchParkings.delete(record.id);
        }
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
     *
     * An Agent launch of the Session that is still in flight (`terminal.create`, `terminal.restart`, a surface switch,
     * a dispatch) had no process to park yet. `parkLaunch` hands it over when it lands while the detach runs, and the
     * detach waits for every such launch before it returns, so none lands afterward unseen.
     */
    async detachSession(sessionId: string): Promise<string[]> {
        this.detaching.add(sessionId);
        try {
            const parked = await this.parkSession(
                sessionId,
                'detached',
                (terminal) => terminal.provider !== undefined,
            );
            await this.options.terminals.settleLaunches(sessionId);
            return parked;
        } finally {
            this.detaching.delete(sessionId);
        }
    }

    /**
     * Stops every live PTY as `stopped` for Terminate and Close, and for an explicit quit before `host.stop`. This is
     * not a shutdown: the Terminal Host and every service keep running, so the next launch, restart, or restore on the
     * same Server Core works. A launch that lands while this runs is stopped too, and the call returns only after every
     * launch in flight settled. `stopped` is final: selecting a Session afterward does not relaunch these Terminals.
     */
    async terminateAll(): Promise<string[]> {
        this.terminating += 1;
        try {
            const stopped = await Promise.all(
                this.options.database
                    .listTerminals()
                    .map(async (terminal) =>
                        (await this.park(terminal, 'terminated')) ? [terminal.id] : [],
                    ),
            );
            await this.options.terminals.settleLaunches();
            this.publish(stopped.flat());
            return stopped.flat();
        } finally {
            this.terminating -= 1;
        }
    }

    async close(): Promise<void> {
        await this.poller?.dispose();
        this.poller = undefined;
    }
}

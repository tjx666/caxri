import type {
    AgentAutomaticNamingHealth,
    AgentProvider,
    AppSettings,
    ServerEvent,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import { agentProviderCatalog, CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { AsyncSemaphore, logEventCatalog } from '@caxri/system';

import type { AgentLifecycleSignal, AgentService } from './agents';
import {
    buildAgentTitlePrompt,
    normalizeGeneratedAgentTitle,
    readAgentTitleGitBranch,
} from './agents';
import type { CaxriDatabase } from './db';
import type { AutoNamingOutcome, AutoNamingReason } from './session-auto-naming-metrics';
import {
    AutoNamingAttempt,
    AutoNamingReasonTally,
    highFrequencyAutoNamingReasons,
} from './session-auto-naming-metrics';
import { isPlaceholderSessionTitle } from './session-policy';
import type { SessionRenameService } from './session-rename';

const MAX_SESSION_SLOTS = 128;
const MINIMUM_TRANSCRIPT_GROWTH_BYTES = 512;
const MINIMUM_GENERATION_INTERVAL_MS = 60_000;
const FAILURE_COOLDOWN_MS = 60_000;
const MAX_CONCURRENT_TITLE_GENERATIONS = 2;

interface NamingTrigger {
    agentSessionId: string;
    enqueuedAt: number;
    launchId: string;
    provider: AgentProvider;
    revision: number;
    sessionId: string;
    terminalId: string;
}

interface NamingSlot {
    attempts: number;
    controller?: AbortController;
    lastAttemptAt?: number;
    lastAttemptBytes?: number;
    lastFailureAt?: number;
    /**
     * When this Session last emitted an `info` naming record, the throttle behind the one-record-per-Session-per-minute
     * budget.
     */
    lastInfoAt?: number;
    latest?: NamingTrigger;
    revision: number;
    running?: Promise<void>;
    /**
     * Counts every attempt's reason, including the ones whose record was written below the production sink's level.
     */
    tally: AutoNamingReasonTally;
}

interface NamingTarget {
    session: SessionRecord;
    terminal: TerminalRecord & { agentSessionId: string; provider: AgentProvider };
}

export interface SessionAutoNamingOptions {
    hasForeignHookConflict: (provider: AgentProvider) => boolean;
    isCurrentLaunch: (terminalId: string, launchId: string) => boolean;
    onHealthChanged?: (provider: AgentProvider, health: AgentAutomaticNamingHealth) => void;
    now?: () => number;
}

function errorKind(error: unknown): string {
    if (error instanceof CaxriError) return error.code;
    return error instanceof Error ? error.name : 'unknown';
}

function failureHealth(error: unknown): AgentAutomaticNamingHealth {
    if (error instanceof CaxriError && error.code === 'TIMEOUT')
        return {
            kind: 'lastAttemptFailed',
            message: 'The naming model timed out. Caxri will retry later.',
        };
    if (error instanceof CaxriError && error.code === 'UNAVAILABLE')
        return {
            kind: 'unavailable',
            message: 'The installed Agent CLI does not support automatic naming.',
        };
    return {
        kind: 'lastAttemptFailed',
        message: 'Automatic naming failed. Caxri will retry later.',
    };
}

/**
 * Owns background Session naming generations. Provider transcript text stays within `AgentService` and the generated
 * prompt is sent only to a provider CLI over stdin; this coordinator persists and emits titles and enum state only.
 */
export class SessionAutoNamingService {
    private closed = false;
    private readonly executions = new AsyncSemaphore(MAX_CONCURRENT_TITLE_GENERATIONS);
    private readonly now: () => number;
    private readonly slots = new Map<string, NamingSlot>();

    constructor(
        private readonly database: CaxriDatabase,
        private readonly agents: AgentService,
        private readonly renames: SessionRenameService,
        private readonly settings: () => AppSettings,
        private readonly emit: (event: ServerEvent) => void,
        private readonly logger: StructuredLogger,
        private readonly options: SessionAutoNamingOptions,
    ) {
        this.now = options.now ?? Date.now;
    }

    private target(trigger: NamingTrigger, canUseStopped = true): NamingTarget | undefined {
        if (this.closed) return;
        const session = this.database.getSession(trigger.sessionId);
        const terminal = this.database.getTerminal(trigger.terminalId);
        const providerSettings = this.settings()['agents.providers'][trigger.provider];
        if (
            !session ||
            !terminal ||
            session.archivedAt !== undefined ||
            session.primaryAgentTerminalId !== trigger.terminalId ||
            session.titleMode !== 'automatic' ||
            (!canUseStopped && session.autoNamingState !== 'active') ||
            terminal.provider !== trigger.provider ||
            terminal.agentSessionId !== trigger.agentSessionId ||
            !this.options.isCurrentLaunch(trigger.terminalId, trigger.launchId) ||
            agentProviderCatalog[trigger.provider].automaticSessionNaming !== 'caxri' ||
            !providerSettings.naming.enabled ||
            !providerSettings.hooks.enabled ||
            this.options.hasForeignHookConflict(trigger.provider)
        ) {
            return;
        }
        return {
            session,
            terminal: terminal as NamingTarget['terminal'],
        };
    }

    private isLatest(sessionId: string, slot: NamingSlot, trigger: NamingTrigger): boolean {
        return this.slots.get(sessionId) === slot && slot.revision === trigger.revision;
    }

    private emitSession(sessionId: string): void {
        this.emit({
            event: 'state.changed',
            payload: { kind: 'records', sessionIds: [sessionId], terminalIds: [] },
        });
    }

    private stopForProviderTitle(sessionId: string): void {
        if (!this.database.sessionNaming.stop(sessionId))
            throw new CaxriError('NOT_FOUND', 'Session not found');
        this.emitSession(sessionId);
    }

    /**
     * Emits the single terminal record for one attempt. `info` is reserved for outcomes a maintainer needs without a
     * reproduction; everything that follows PTY activity rather than naming work stays at `debug`, and a Session that
     * already logged at `info` inside {@link MINIMUM_GENERATION_INTERVAL_MS} is downgraded too. The interval gate alone
     * cannot hold that budget: `slot.lastAttemptAt` is stamped only once an attempt reaches the generation step, so
     * every earlier exit re-runs in full on the next completed turn (issue #504).
     */
    private finishAttempt(
        slot: NamingSlot,
        trigger: NamingTrigger,
        attempt: AutoNamingAttempt,
        outcome: AutoNamingOutcome,
        reason: AutoNamingReason,
    ): void {
        const at = this.now();
        const durationMs = attempt.durationMs(at);
        slot.tally.record(reason, durationMs);
        let level: 'info' | 'debug' = 'debug';
        if (
            !highFrequencyAutoNamingReasons.has(reason) &&
            (slot.lastInfoAt === undefined ||
                at - slot.lastInfoAt >= MINIMUM_GENERATION_INTERVAL_MS)
        ) {
            slot.lastInfoAt = at;
            level = 'info';
        }
        this.logger.write(level, logEventCatalog.agent.autoNamingFinished, {
            durationMs,
            fields: {
                attempt: attempt.ordinal,
                outcome,
                provider: trigger.provider,
                reason,
                stage: attempt.stage,
                ...attempt.stageFields(at),
                ...(level === 'info' && slot.tally.fields()),
            },
        });
    }

    /**
     * `target(trigger, false)` rejects a Session that became ineligible and one whose automatic naming was stopped
     * mid-attempt. Only the second is actionable, and it is the state a maintainer most often needs to confirm, so the
     * two are recorded apart instead of collapsing into one reason.
     */
    private ineligibleReason(trigger: NamingTrigger): AutoNamingReason {
        const session = this.database.getSession(trigger.sessionId);
        // A Session that no longer exists is ineligible, not a Session whose user stopped automatic naming.
        if (!session) return 'targetIneligible';
        return session.autoNamingState === 'active' ? 'targetIneligible' : 'autoNamingStopped';
    }

    /**
     * Runs one naming attempt and records exactly where it stopped. Every early return is classified rather than
     * silent, because "nothing happened" is the most common automatic-naming report and a stage alone cannot say why.
     */
    private async execute(
        slot: NamingSlot,
        trigger: NamingTrigger,
        signal: AbortSignal,
        attempt: AutoNamingAttempt,
    ): Promise<void> {
        const finish = (outcome: AutoNamingOutcome, reason: AutoNamingReason): void =>
            this.finishAttempt(slot, trigger, attempt, outcome, reason);
        const initial = this.target(trigger);
        if (!initial) return finish('skipped', 'targetIneligible');
        if (signal.aborted) return finish('cancelled', 'aborted');
        const now = this.now();
        if (slot.lastFailureAt && now - slot.lastFailureAt < FAILURE_COOLDOWN_MS)
            return finish('skipped', 'failureCooldown');
        if (slot.lastAttemptAt && now - slot.lastAttemptAt < MINIMUM_GENERATION_INTERVAL_MS)
            return finish('skipped', 'minimumInterval');
        attempt.enter('sourceRead');
        const source = await this.agents.readTitleSource(trigger.provider, {
            agentSessionId: trigger.agentSessionId,
            rootPath: initial.terminal.cwd,
        });
        if (!source) {
            this.options.onHealthChanged?.(trigger.provider, {
                kind: 'lastAttemptBlocked',
                message: 'The bound Agent Session history is unavailable.',
            });
            return finish('blocked', 'sourceUnavailable');
        }
        /**
         * `isLatest` is checked first: every site that bumps the revision also aborts the controller, so testing the
         * signal first would report a newer trigger as a plain cancellation and make `cancelled` mean two things.
         */
        if (!this.isLatest(trigger.sessionId, slot, trigger))
            return finish('superseded', 'supersededByNewerTrigger');
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- the signal can abort while source IO awaits
        if (signal.aborted) return finish('cancelled', 'aborted');
        attempt.enter('ownershipCheck');
        const current = this.target(trigger);
        if (!current) return finish('skipped', 'targetIneligible');
        if (source.userMessages.length === 0) return finish('skipped', 'noUserMessages');
        const ownership = this.database.sessionNaming.get(trigger.sessionId);
        if (!ownership) return finish('blocked', 'ownershipMissing');
        if (source.providerTitleState === 'unknown') {
            this.options.onHealthChanged?.(trigger.provider, {
                kind: 'lastAttemptBlocked',
                message: 'The provider Session name could not be verified safely.',
            });
            return finish('blocked', 'providerTitleUnverifiable');
        }
        if (source.providerTitleState === 'explicit') {
            if (
                !source.currentProviderTitle ||
                source.currentProviderTitle !== ownership.lastAutoTitle
            ) {
                this.stopForProviderTitle(trigger.sessionId);
                return finish('blocked', 'providerTitleExplicit');
            }
        } else if (ownership.state === 'stopped' || ownership.lastAutoTitle) {
            const resumed = await this.renames.resumeAutomaticNaming(
                trigger.sessionId,
                async () => {
                    if (!this.isLatest(trigger.sessionId, slot, trigger) || !this.target(trigger))
                        return false;
                    const latest = await this.agents.readTitleOwnership(trigger.provider, {
                        agentSessionId: trigger.agentSessionId,
                        rootPath: current.terminal.cwd,
                    });
                    return latest.providerTitleState === 'absent';
                },
            );
            if (!resumed) return finish('blocked', 'resumeDeclined');
        }
        if (!this.target(trigger, false)) return finish('skipped', this.ineligibleReason(trigger));
        if (
            slot.lastAttemptBytes !== undefined &&
            source.byteLength >= slot.lastAttemptBytes &&
            source.byteLength - slot.lastAttemptBytes < MINIMUM_TRANSCRIPT_GROWTH_BYTES
        ) {
            return finish('skipped', 'transcriptGrowthBelowThreshold');
        }
        slot.lastAttemptAt = now;
        slot.lastAttemptBytes = source.byteLength;
        source.currentProviderTitle ??= isPlaceholderSessionTitle(current.session.displayTitle)
            ? undefined
            : current.session.displayTitle;
        attempt.enter('branchRead');
        source.gitBranch ??= await readAgentTitleGitBranch(current.terminal.cwd);
        if (!this.isLatest(trigger.sessionId, slot, trigger))
            return finish('superseded', 'supersededByNewerTrigger');
        attempt.enter('providerGeneration');
        const generated = await this.agents.generateSessionTitle(trigger.provider, {
            cwd: current.terminal.cwd,
            prompt: buildAgentTitlePrompt(source),
            signal,
        });
        if (!this.isLatest(trigger.sessionId, slot, trigger))
            return finish('superseded', 'supersededByNewerTrigger');
        if (!this.target(trigger, false)) return finish('skipped', this.ineligibleReason(trigger));
        const title = normalizeGeneratedAgentTitle(generated);
        if (!title) return finish('skipped', 'emptyTitle');
        if (title === source.currentProviderTitle) return finish('skipped', 'unchangedTitle');
        attempt.enter('rename');
        const applied = await this.renames.renameAutomatically(
            trigger.sessionId,
            title,
            () =>
                this.isLatest(trigger.sessionId, slot, trigger) &&
                Boolean(this.target(trigger, false)),
            signal,
            async () => {
                if (
                    !this.isLatest(trigger.sessionId, slot, trigger) ||
                    !this.target(trigger, false)
                )
                    return false;
                const latest = await this.agents.readTitleOwnership(trigger.provider, {
                    agentSessionId: trigger.agentSessionId,
                    rootPath: current.terminal.cwd,
                });
                if (latest.providerTitleState === 'unknown') return false;
                if (
                    latest.providerTitleState === 'explicit' &&
                    (source.providerTitleState !== 'explicit' ||
                        latest.currentProviderTitle !== source.currentProviderTitle)
                ) {
                    this.stopForProviderTitle(trigger.sessionId);
                    return false;
                }
                return true;
            },
        );
        if (!applied) return finish('skipped', 'renameDeclined');
        slot.lastFailureAt = undefined;
        this.options.onHealthChanged?.(trigger.provider, { kind: 'ready' });
        attempt.enter('complete');
        finish('renamed', 'completed');
    }

    private async drain(slot: NamingSlot): Promise<void> {
        try {
            while (!this.closed && slot.latest) {
                const trigger = slot.latest;
                slot.latest = undefined;
                const controller = new AbortController();
                slot.controller = controller;
                slot.attempts += 1;
                /**
                 * Created before the concurrency semaphore so `queued` covers the wait for a generation slot, which is
                 * the stage a saturated naming queue shows up in.
                 */
                const attempt = new AutoNamingAttempt(this.now, trigger.enqueuedAt, slot.attempts);
                try {
                    // eslint-disable-next-line no-await-in-loop -- one valid task per Session is the concurrency contract
                    await this.executions.run(() =>
                        this.execute(slot, trigger, controller.signal, attempt),
                    );
                } catch (error) {
                    /**
                     * An abort surfaces here as a provider rejection. Recording it keeps a cancellation that already
                     * spent model time from vanishing without a stage or a duration.
                     */
                    if (controller.signal.aborted)
                        this.finishAttempt(slot, trigger, attempt, 'cancelled', 'aborted');
                    else if (!this.database.getSession(trigger.sessionId)) {
                        /**
                         * The Session was deleted while the provider call was in flight. Reporting provider health here
                         * would degrade the Settings indicator for a rejection that only means the target went away.
                         */
                        this.finishAttempt(slot, trigger, attempt, 'skipped', 'targetIneligible');
                    } else {
                        const at = this.now();
                        slot.lastFailureAt = at;
                        slot.tally.record('failed', attempt.durationMs(at));
                        this.logger.write('warn', logEventCatalog.agent.autoNamingFailed, {
                            durationMs: attempt.durationMs(at),
                            fields: {
                                attempt: attempt.ordinal,
                                errorKind: errorKind(error),
                                provider: trigger.provider,
                                stage: attempt.stage,
                                ...attempt.stageFields(at),
                                ...slot.tally.fields(),
                            },
                        });
                        this.options.onHealthChanged?.(trigger.provider, failureHealth(error));
                    }
                } finally {
                    if (slot.controller === controller) slot.controller = undefined;
                }
            }
        } finally {
            slot.running = undefined;
            if (slot.latest && !this.closed) this.run(slot);
        }
    }

    private run(slot: NamingSlot): void {
        slot.running = this.drain(slot);
    }

    private slot(sessionId: string): NamingSlot {
        let slot = this.slots.get(sessionId);
        if (!slot) {
            slot = { attempts: 0, revision: 0, tally: new AutoNamingReasonTally() };
            this.slots.set(sessionId, slot);
            if (this.slots.size > MAX_SESSION_SLOTS) {
                const oldest = [...this.slots].find(([, candidate]) => !candidate.running);
                if (oldest) this.slots.delete(oldest[0]);
            }
        }
        return slot;
    }

    private invalidateSession(sessionId: string): void {
        const slot = this.slots.get(sessionId);
        if (!slot) return;
        slot.revision += 1;
        slot.latest = undefined;
        slot.controller?.abort();
    }

    observe(signal: AgentLifecycleSignal): void {
        if (signal.agentId) return;
        const terminal = this.database.getTerminal(signal.terminalId);
        if (!terminal) return;
        const session = this.database.getSession(terminal.sessionId);
        if (!session || session.primaryAgentTerminalId !== terminal.id) return;
        if (signal.phase !== 'turnFinished') {
            if (signal.phase === 'turnStarted' || signal.phase === 'sessionIdentified')
                this.invalidateSession(session.id);
            return;
        }
        if (!terminal.provider || !terminal.agentSessionId) return;
        if (agentProviderCatalog[terminal.provider].automaticSessionNaming !== 'caxri') return;
        const slot = this.slot(session.id);
        slot.revision += 1;
        slot.controller?.abort();
        slot.latest = {
            agentSessionId: terminal.agentSessionId,
            enqueuedAt: this.now(),
            launchId: signal.launchId,
            provider: terminal.provider,
            revision: slot.revision,
            sessionId: session.id,
            terminalId: terminal.id,
        };
        if (!slot.running) this.run(slot);
    }

    pauseSession(sessionId: string): void {
        this.invalidateSession(sessionId);
    }

    forgetSession(sessionId: string): void {
        this.invalidateSession(sessionId);
        this.slots.delete(sessionId);
    }

    /**
     * A Terminal row is the only mapping back to its Session. When the row is already gone the owning Session was
     * deleted or archived, and {@link forgetSession} has invalidated the slot; there is nothing left to cancel, so the
     * missing mapping is an expected silent exit rather than a lost invalidation.
     */
    forgetTerminal(terminalId: string): void {
        const sessionId = this.database.getTerminal(terminalId)?.sessionId;
        if (sessionId) this.invalidateSession(sessionId);
    }

    async resumeSession(sessionId: string): Promise<SessionRecord> {
        this.invalidateSession(sessionId);
        const session = this.database.getSession(sessionId);
        if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
        const terminal = session.primaryAgentTerminalId
            ? this.database.getTerminal(session.primaryAgentTerminalId)
            : undefined;
        if (
            !terminal?.provider ||
            agentProviderCatalog[terminal.provider].automaticSessionNaming !== 'caxri'
        ) {
            throw new CaxriError(
                'CONFLICT',
                'Caxri does not own automatic naming for this Session',
            );
        }
        const resumed = await this.renames.resumeAutomaticNaming(sessionId);
        if (!resumed) throw new CaxriError('NOT_FOUND', 'Session not found');
        /**
         * Resuming is an explicit request for a name now. The throttles exist to stop Caxri renaming a Session it just
         * named, but they outlive the stop: keeping them would silently swallow the first turn after the user asked for
         * naming back, which reads as the button doing nothing. The reset happens only once the resume is accepted, so
         * a rejected request cannot widen the window for a Session Caxri does not own.
         */
        const slot = this.slots.get(sessionId);
        if (slot) {
            slot.lastAttemptAt = undefined;
            slot.lastAttemptBytes = undefined;
            slot.lastFailureAt = undefined;
        }
        return resumed;
    }

    reconcile(settings: AppSettings['agents.providers']): void {
        for (const [sessionId, slot] of this.slots) {
            const session = this.database.getSession(sessionId);
            const terminal = session?.primaryAgentTerminalId
                ? this.database.getTerminal(session.primaryAgentTerminalId)
                : undefined;
            if (
                !terminal?.provider ||
                !settings[terminal.provider].naming.enabled ||
                !settings[terminal.provider].hooks.enabled ||
                this.options.hasForeignHookConflict(terminal.provider)
            ) {
                slot.revision += 1;
                slot.latest = undefined;
                slot.controller?.abort();
            }
        }
    }

    async close(): Promise<void> {
        if (this.closed) {
            await Promise.allSettled(
                this.slots.values().flatMap((slot) => (slot.running ? [slot.running] : [])),
            );
            return;
        }
        this.closed = true;
        const running = this.slots.values().flatMap((slot) => (slot.running ? [slot.running] : []));
        for (const slot of this.slots.values()) {
            slot.latest = undefined;
            slot.controller?.abort();
        }
        await Promise.allSettled(running);
        this.slots.clear();
    }
}

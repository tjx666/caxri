import type { AgentOperation, AgentProvider, ServerEvent, TerminalRecord } from '@caxri/protocol';
import { errorMessage } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import { CoalescedScheduler } from '../coalesced-scheduler';
import type { CaxriDatabase } from '../db';
import { SingleFlight } from '../single-flight';
import { AgentAttentionTracker } from './attention-tracker';
import { agentProviderStateRoot } from './contract';
import { HookLaunchTracker } from './hook-launch-tracker';
import type { AgentLifecycleSignal, AgentSignalDecision } from './hooks/contract';
import { AgentLifecycleWatchdogs, isStandaloneEscape } from './lifecycle-watchdogs';
import type { MetadataActivityBaseline } from './metadata-activity-baseline';
import {
    isMetadataActivityBaselineMatch,
    metadataActivityBaseline,
    reconcileMetadataActivityBaseline,
} from './metadata-activity-baseline';
import { detectForegroundAgentProvider } from './process-detection';
import { ProcessIdentityProbe } from './process-identity-probe';
import type { AgentService } from './service';
import type { SessionActivitySource } from './session-activity-log';
import { hasSessionActivityChanged } from './session-activity-log';
import { ShellProcessProbe } from './shell-process-probe';
import type { ShellInputState, ShellPromotionCandidate } from './shell-promotion';
import {
    decideInputPromotionCandidate,
    MAX_SHELL_COMMAND_LENGTH,
    SHELL_PROMOTION_WINDOW_MS,
} from './shell-promotion';
import { AgentWorkTracker } from './work-tracker';

const AGENT_METADATA_REFRESH_DELAY_MS = 2_000;
const AGENT_COMPACTION_TIMEOUT_MS = 5 * 60_000;
const AGENT_RUNNING_WATCHDOG_INTERVAL_MS = 5 * 60_000;
const MAX_SHELL_PROMOTION_PROBES = 3;
const BRACKETED_PASTE_START = '\u{1B}[200~';
const BRACKETED_PASTE_END = '\u{1B}[201~';

export interface AgentCoordinatorOptions {
    /**
     * Trailing delay before Agent Terminal output refreshes durable Agent metadata.
     */
    refreshDelayMs?: number;
    /**
     * Safety bound for a lost `PostCompact` signal. Production uses five minutes; tests may shorten it.
     */
    compactionTimeoutMs?: number;
    runningWatchdogIntervalMs?: number;
    detectForegroundAgent?: (shellPid: number) => Promise<AgentProvider | undefined>;
    /**
     * Delay between bounded foreground-process retries. Production uses one second; tests may shorten it.
     */
    shellProcessProbeIntervalMs?: number;
}

/**
 * Single owner of Agent metadata probing. It decides which Terminals are Agent Terminals, schedules the trailing
 * refresh their output implies, and runs the immediate probes that Session and Terminal lifecycle changes require, so
 * no other module needs to track Agent Terminal identity.
 */
export class AgentCoordinator {
    private readonly lifecycleWatchdogs: AgentLifecycleWatchdogs;
    private readonly excludedAgentSessionIdsByTerminal = new Map<string, Set<string>>();
    private readonly refreshes: CoalescedScheduler<string>;
    private readonly probes = new SingleFlight<string, void>();
    private readonly trailingProbeRequests = new Set<string>();
    private readonly shellInputs = new Map<string, ShellInputState>();
    private readonly processIdentityProbe = new ProcessIdentityProbe();
    private readonly shellProcessProbe: ShellProcessProbe;
    private readonly shellPromotionCandidates = new Map<string, ShellPromotionCandidate>();
    private readonly startedAtByTerminal = new Map<string, number>();
    private readonly probeGenerations = new Map<string, number>();
    private readonly launchIdsByTerminal = new Map<string, string>();
    private readonly hookLaunches = new HookLaunchTracker();
    private readonly attention = new AgentAttentionTracker();
    private readonly work = new AgentWorkTracker((signal) =>
        this.applyLifecycle(signal, 'deferredHook'),
    );
    /**
     * Tracks whether provider metadata is still only the launch baseline; `null` marks a real transition.
     */
    private readonly metadataActivityBaselines = new Map<string, MetadataActivityBaseline | null>();

    constructor(
        private readonly database: CaxriDatabase,
        private readonly agents: AgentService,
        private readonly emit: (event: ServerEvent) => void,
        private readonly logger: StructuredLogger,
        options: AgentCoordinatorOptions = {},
    ) {
        this.shellProcessProbe = new ShellProcessProbe({
            detect: options.detectForegroundAgent ?? detectForegroundAgentProvider,
            intervalMs: options.shellProcessProbeIntervalMs,
            isCurrent: (terminalId, candidate) =>
                this.shellPromotionCandidates.get(terminalId) === candidate &&
                candidate.expiresAt >= Date.now(),
            isWatchCurrent: (terminalId, provider) => {
                const terminal = this.database.getTerminal(terminalId);
                return (
                    terminal?.provider === provider &&
                    terminal.lastProcessState === 'running' &&
                    terminal.lastAgentProcessState === 'running'
                );
            },
            onConfirmed: (terminalId, provider, candidate) =>
                this.confirmShellPromotion(terminalId, provider, candidate),
            onError: (terminalId, error) =>
                this.logger.write('warn', logEventCatalog.agent.processProbeFailed, {
                    fields: { terminalId, error: errorMessage(error, 'unknown') },
                }),
            onExhausted: (terminalId, candidate) => {
                if (
                    !candidate.provider &&
                    this.shellPromotionCandidates.get(terminalId) === candidate
                ) {
                    this.shellPromotionCandidates.delete(terminalId);
                }
            },
            onInactive: (terminalId, provider) => {
                if (!this.database.revokeForegroundAgentProvider(terminalId, provider)) return;
                this.emitAgentMetadataChange(terminalId);
            },
        });
        this.refreshes = new CoalescedScheduler(
            options.refreshDelayMs ?? AGENT_METADATA_REFRESH_DELAY_MS,
            (terminalId: string) => this.probe(terminalId),
        );
        this.lifecycleWatchdogs = new AgentLifecycleWatchdogs(
            options.compactionTimeoutMs ?? AGENT_COMPACTION_TIMEOUT_MS,
            options.runningWatchdogIntervalMs ?? AGENT_RUNNING_WATCHDOG_INTERVAL_MS,
            (terminalId) => this.emitAgentMetadataChange(terminalId),
            async (terminalId, launchId) => {
                if (this.launchIdsByTerminal.get(terminalId) !== launchId) return false;
                await this.probe(terminalId);
                const terminal = this.database.getTerminal(terminalId);
                return (
                    this.launchIdsByTerminal.get(terminalId) === launchId &&
                    terminal !== undefined &&
                    this.database.getSession(terminal.sessionId)?.lastActivityState === 'running'
                );
            },
        );
    }

    private emitAgentMetadataChange(terminalId: string): void {
        const terminal = this.database.getTerminal(terminalId);
        if (!terminal) return;
        this.emit({
            event: 'state.changed',
            payload: {
                kind: 'records',
                sessionIds: [terminal.sessionId],
                terminalIds: [terminal.id],
            },
        });
    }

    private forgetLifecycleState(terminalId: string): void {
        this.attention.forget(terminalId);
        this.work.forget(terminalId);
    }

    private applyLifecycle(
        event: AgentLifecycleSignal,
        source: SessionActivitySource = 'hook',
    ): void {
        if (event.phase === 'turnFinished') {
            this.attention.forget(event.terminalId);
            this.lifecycleWatchdogs.stopRunningTurn(event.terminalId);
            this.hookLaunches.markAuthoritative(event.terminalId, event.launchId);
        }
        if (
            hasSessionActivityChanged(this.database, this.logger, {
                applyWrite: () => this.database.updateAgentLifecycle(event),
                phase: event.phase,
                source,
                terminalId: event.terminalId,
            })
        )
            this.emitAgentMetadataChange(event.terminalId);
    }

    /**
     * Applies a confirmed Shell promotion or provider switch; false keeps the bounded candidate alive.
     */
    private confirmShellPromotion(
        terminalId: string,
        provider: AgentProvider,
        candidate: ShellPromotionCandidate,
    ): boolean {
        const terminal = this.database.getTerminal(terminalId);
        if (!terminal) return false;
        if (terminal.provider === provider) {
            /**
             * Managed control remains fenced by the absent launch ID and Agent process ID.
             */
            if (!this.database.confirmForegroundAgentProvider(terminalId, provider)) return false;
        } else if (terminal.provider) {
            if (!this.database.confirmForegroundAgentProvider(terminalId, provider)) return false;
            this.probeGenerations.set(terminalId, (this.probeGenerations.get(terminalId) ?? 0) + 1);
            this.hookLaunches.forget(terminalId);
            this.forgetLifecycleState(terminalId);
        } else if (!this.database.promoteShellToAgent(terminalId, provider)) {
            return false;
        }
        if (candidate.agentSessionId)
            this.database.rebindAgentSession(terminalId, provider, candidate.agentSessionId);
        this.shellInputs.delete(terminalId);
        this.shellPromotionCandidates.delete(terminalId);
        this.startedAtByTerminal.set(terminalId, candidate.startedAt);
        this.emitAgentMetadataChange(terminalId);
        if (candidate.lifecycleSignal) this.observeLifecycleSignal(candidate.lifecycleSignal);
        this.refreshes.schedule(terminalId);
        return true;
    }

    private async probe(terminalId: string, shouldRetryClaim = true): Promise<void> {
        const isJoining = this.probes.has(terminalId);
        if (isJoining) this.trailingProbeRequests.add(terminalId);
        await this.probes.run(terminalId, () => this.probeOnce(terminalId, shouldRetryClaim));
        if (isJoining) return;
        if (this.trailingProbeRequests.delete(terminalId))
            await this.probe(terminalId, shouldRetryClaim);
    }

    /**
     * Runs one serialized observation. {@link probe} preserves a trailing read requested while this one is in flight.
     */
    private async probeOnce(terminalId: string, shouldRetryClaim = true): Promise<void> {
        try {
            const generation = this.probeGenerations.get(terminalId) ?? 0;
            const terminal = this.database.getTerminal(terminalId);
            if (!terminal) return;
            if (!terminal.provider) {
                await this.probeShellPromotion(terminal, shouldRetryClaim);
                return;
            }
            if (await this.probeProviderSwitch(terminal)) return;
            const session = this.database.getSession(terminal.sessionId);
            if (!session) return;
            const excludedAgentSessionIds = [
                ...(this.excludedAgentSessionIdsByTerminal.get(terminal.id) ?? []),
                ...this.database.claimedAgentSessionIds(terminal.id),
            ];
            const snapshot = await this.agents.snapshot(terminal.provider, {
                agentSessionId: terminal.agentSessionId,
                agentTurnId: this.lifecycleWatchdogs.agentTurnId(terminal.id),
                correlationId: terminal.id,
                excludedAgentSessionIds,
                rootPath: agentProviderStateRoot(terminal),
                shellPid: this.processIdentityProbe.take(terminal),
                processState: terminal.lastProcessState,
                startedAt: this.startedAtByTerminal.get(terminal.id) ?? terminal.createdAt,
            });
            if ((this.probeGenerations.get(terminalId) ?? 0) !== generation) return;
            if (
                snapshot.sessionId &&
                snapshot.sessionId !== terminal.agentSessionId &&
                this.database.isAgentSessionClaimedByOtherTerminal(terminal.id, snapshot.sessionId)
            ) {
                if (shouldRetryClaim) await this.probeOnce(terminalId, false);
                return;
            }
            const currentSession = this.database.getSession(terminal.sessionId);
            if (!currentSession) return;
            const launchId = this.launchIdsByTerminal.get(terminal.id);
            /**
             * The hook owns the activity state after it reported a turn boundary, and also between `turnStarted` and
             * the applied `turnFinished` when the probe found no provider evidence: the 2-second trailing refresh
             * otherwise raced the hook and left the Session without its running cue for the whole turn (issue #568).
             */
            const isHookOwned =
                this.hookLaunches.isAuthoritative(terminal.id, launchId) ||
                (snapshot.status === 'unknown' &&
                    this.hookLaunches.isTurnInFlight(terminal.id, launchId));
            const hasMetadataBaseline = this.metadataActivityBaselines.has(terminal.id);
            const activityBaseline = this.metadataActivityBaselines.get(terminal.id);
            const isBaselineReconciliation =
                !hasMetadataBaseline ||
                (activityBaseline !== null &&
                    activityBaseline !== undefined &&
                    isMetadataActivityBaselineMatch(activityBaseline, snapshot));
            if (!hasMetadataBaseline)
                this.metadataActivityBaselines.set(terminal.id, metadataActivityBaseline(snapshot));
            else if (!isBaselineReconciliation)
                this.metadataActivityBaselines.set(terminal.id, null);
            const activityState = currentSession.lastActivityState;
            const metadataSnapshot = isHookOwned
                ? { ...snapshot, attentionKind: undefined, status: activityState }
                : isBaselineReconciliation
                  ? reconcileMetadataActivityBaseline(snapshot, activityState)
                  : snapshot;
            const isRecordActivity = !isBaselineReconciliation && !isHookOwned;
            if (
                hasSessionActivityChanged(this.database, this.logger, {
                    applyWrite: () =>
                        this.database.updateAgentMetadata(
                            terminal.id,
                            metadataSnapshot,
                            isRecordActivity,
                        ),
                    source: 'probe',
                    terminalId: terminal.id,
                })
            )
                this.emitAgentMetadataChange(terminal.id);
        } catch (error) {
            /**
             * A failed probe degrades Agent metadata to unknown; it never interrupts the Server.
             */
            this.logger.write('warn', logEventCatalog.agent.probeFailed, {
                fields: {
                    terminalId,
                    error: errorMessage(error, 'unknown'),
                },
            });
        }
    }

    /**
     * Metadata fallback for an input-opened switch candidate on an already-bound Agent Terminal. The foreground-process
     * probe cannot recognize every install shape (native binaries hide behind interpreters, sandboxes can block `ps`),
     * so a direct different-provider command the user submitted at the prompt may instead be confirmed by the candidate
     * provider reporting a session that started inside the candidate window. Hook-opened candidates stay excluded: a
     * nested agent tool-call also creates a real provider session, which only the process probe can tell apart.
     */
    private async probeProviderSwitch(terminal: TerminalRecord): Promise<boolean> {
        const candidate = this.shellPromotionCandidates.get(terminal.id);
        if (
            candidate?.origin !== 'input' ||
            !candidate.provider ||
            candidate.provider === terminal.provider
        ) {
            return false;
        }
        if (candidate.expiresAt < Date.now()) {
            this.shellPromotionCandidates.delete(terminal.id);
            return false;
        }
        const provider = candidate.provider;
        candidate.attempts += 1;
        const snapshot = await this.agents.snapshot(provider, {
            correlationId: `${terminal.id}:provider-switch:${candidate.startedAt}`,
            excludedAgentSessionIds: this.database.claimedAgentSessionIdsForProvider(
                provider,
                terminal.id,
            ),
            rootPath: agentProviderStateRoot(terminal),
            processState: terminal.lastProcessState,
            startedAt: candidate.startedAt,
        });
        const currentCandidate = this.shellPromotionCandidates.get(terminal.id);
        if (
            currentCandidate !== candidate ||
            currentCandidate.origin !== 'input' ||
            candidate.expiresAt < Date.now()
        ) {
            return false;
        }
        if (
            !snapshot.sessionId ||
            this.database.isAgentSessionClaimedByOtherTerminal(terminal.id, snapshot.sessionId)
        ) {
            if (candidate.attempts < MAX_SHELL_PROMOTION_PROBES)
                this.refreshes.schedule(terminal.id);
            return false;
        }
        if (!this.database.confirmForegroundAgentProvider(terminal.id, provider)) return false;
        /**
         * Invalidate in-flight probes for the previous provider and drop its hook status authority so a late result
         * cannot republish the old identity over the switched one.
         */
        this.probeGenerations.set(terminal.id, (this.probeGenerations.get(terminal.id) ?? 0) + 1);
        this.hookLaunches.forget(terminal.id);
        this.forgetLifecycleState(terminal.id);
        this.database.rebindAgentSession(terminal.id, provider, snapshot.sessionId);
        this.shellInputs.delete(terminal.id);
        this.shellPromotionCandidates.delete(terminal.id);
        this.startedAtByTerminal.set(terminal.id, candidate.startedAt);
        this.emitAgentMetadataChange(terminal.id);
        this.refreshes.schedule(terminal.id);
        return true;
    }

    private async probeShellPromotion(
        terminal: TerminalRecord,
        shouldRetryClaim: boolean,
    ): Promise<void> {
        const candidate = this.shellPromotionCandidates.get(terminal.id);
        if (!candidate?.provider || terminal.kind !== 'shell' || candidate.origin !== 'input')
            return;
        const provider = candidate.provider;
        if (candidate.expiresAt < Date.now()) {
            this.shellPromotionCandidates.delete(terminal.id);
            return;
        }
        const session = this.database.getSession(terminal.sessionId);
        if (!session) return;
        candidate.attempts += 1;
        const snapshot = await this.agents.snapshot(provider, {
            correlationId: `${terminal.id}:shell-promotion:${candidate.startedAt}`,
            excludedAgentSessionIds: this.database.claimedAgentSessionIdsForProvider(
                provider,
                terminal.id,
            ),
            rootPath: agentProviderStateRoot(terminal),
            processState: terminal.lastProcessState,
            startedAt: candidate.startedAt,
        });
        const currentCandidate = this.shellPromotionCandidates.get(terminal.id);
        if (
            currentCandidate !== candidate ||
            currentCandidate.origin !== 'input' ||
            candidate.expiresAt < Date.now()
        ) {
            return;
        }
        if (!snapshot.sessionId) {
            if (candidate.attempts < MAX_SHELL_PROMOTION_PROBES)
                this.refreshes.schedule(terminal.id);
            return;
        }
        if (!this.database.promoteShellToAgent(terminal.id, provider, snapshot)) {
            if (shouldRetryClaim) await this.probeOnce(terminal.id, false);
            return;
        }
        this.shellInputs.delete(terminal.id);
        this.shellPromotionCandidates.delete(terminal.id);
        this.startedAtByTerminal.set(terminal.id, candidate.startedAt);
        this.emitAgentMetadataChange(terminal.id);
    }

    /**
     * Opens a bounded promotion, reactivation, or provider-switch candidate for one submitted command line. A Shell
     * accepts any inspectable command; an inactive Agent Terminal also accepts its bound provider, while a live Agent
     * ignores that direct command. The independent foreground-process probe must still confirm every durable change.
     */
    private openPromotionCandidate(terminalId: string, command: string): void {
        const terminal = this.database.getTerminal(terminalId);
        if (!terminal) return;
        const decision = decideInputPromotionCandidate(terminal, command, Date.now());
        if (decision === 'ignore') return;
        if (decision === 'clear') {
            this.shellPromotionCandidates.delete(terminalId);
            return;
        }
        this.shellPromotionCandidates.set(terminalId, decision);
        if (decision.provider) this.refreshes.schedule(terminalId);
    }

    /**
     * Returns the current Server-only Agent subphase projected onto a Terminal read model.
     */
    agentOperation(terminalId: string): AgentOperation | undefined {
        return this.lifecycleWatchdogs.operation(terminalId);
    }

    /**
     * Tracks only the current unpublished input line and never logs or persists it. Detection is intentionally
     * conservative: a direct `claude` or `codex` command creates a short-lived candidate, while shell editing escape
     * sequences disable detection until the next submission. Provider metadata must still confirm the launch before
     * durable Terminal identity changes.
     */
    observeInput(terminalId: string, data: string): boolean {
        let state = this.shellInputs.get(terminalId);
        if (!state) {
            const terminal = this.database.getTerminal(terminalId);
            if (!terminal) return false;
            state = { command: '', isBracketedPaste: false, valid: true };
        }
        this.lifecycleWatchdogs.observeInput(terminalId, data);
        if (isStandaloneEscape(data)) this.hookLaunches.markTurnInterrupted(terminalId);
        let didSubmit = false;
        for (let index = 0; index < data.length; index += 1) {
            if (data.startsWith(BRACKETED_PASTE_START, index)) {
                state.isBracketedPaste = true;
                index += BRACKETED_PASTE_START.length - 1;
                continue;
            }
            if (data.startsWith(BRACKETED_PASTE_END, index)) {
                state.isBracketedPaste = false;
                index += BRACKETED_PASTE_END.length - 1;
                continue;
            }
            const character = data[index];
            if (character === '\r' || character === '\n') {
                if (state.isBracketedPaste) {
                    state.command += '\n';
                    state.valid = false;
                    continue;
                }
                const hasContent = Boolean(state.command.trim());
                didSubmit ||= hasContent;
                if (hasContent && state.valid)
                    this.openPromotionCandidate(terminalId, state.command);
                state = { command: '', isBracketedPaste: false, valid: true };
                continue;
            }
            if (character === '\u{3}' || character === '\u{15}') {
                state = { command: '', isBracketedPaste: false, valid: true };
                this.shellPromotionCandidates.delete(terminalId);
                continue;
            }
            if (character === '\b' || character === '\u{7F}') {
                if (state.valid) state.command = [...state.command].slice(0, -1).join('');
                continue;
            }
            if (character === '\u{1B}' || character === '\t') {
                state.valid = false;
                continue;
            }
            if (character < ' ') continue;
            if (!state.valid) continue;
            state.command += character;
            if (state.command.length > MAX_SHELL_COMMAND_LENGTH) state.valid = false;
        }
        this.shellInputs.set(terminalId, state);
        return didSubmit;
    }

    /**
     * Agent membership normally comes from the durable provider. A Shell with a simple-command candidate first confirms
     * its foreground process; direct commands retain metadata probing as a fallback when process inspection is
     * unavailable.
     */
    observeOutput(terminalId: string, shellPid?: number): void {
        const terminal = this.database.getTerminal(terminalId);
        if (!terminal) return;
        this.processIdentityProbe.observe(terminalId, shellPid);
        const candidate = this.shellPromotionCandidates.get(terminalId);
        const isCandidateLive = candidate !== undefined && candidate.expiresAt >= Date.now();
        if (candidate && !isCandidateLive) {
            this.shellPromotionCandidates.delete(terminalId);
            this.shellProcessProbe.cancel(terminalId);
        }
        if (isCandidateLive && shellPid !== undefined)
            this.shellProcessProbe.observe(terminalId, shellPid, candidate);
        if (!terminal.provider && !(isCandidateLive && candidate.provider)) return;
        this.refreshes.schedule(terminalId);
    }

    /**
     * Establishes the opaque PTY generation that every accepted hook signal must match.
     */
    beginTerminalLaunch(terminalId: string, launchId: string): void {
        this.lifecycleWatchdogs.forget(terminalId, true);
        this.launchIdsByTerminal.set(terminalId, launchId);
        this.hookLaunches.forget(terminalId);
        this.forgetLifecycleState(terminalId);
    }

    isCurrentTerminalLaunch(terminalId: string, launchId: string): boolean {
        return this.launchIdsByTerminal.get(terminalId) === launchId;
    }

    /**
     * Retires lifecycle and in-flight probe authority so a late lookup cannot bind a thread after its PTY exits.
     */
    endTerminalLaunch(terminalId: string): void {
        this.shellInputs.delete(terminalId);
        this.shellPromotionCandidates.delete(terminalId);
        this.shellProcessProbe.cancel(terminalId);
        this.probeGenerations.set(terminalId, (this.probeGenerations.get(terminalId) ?? 0) + 1);
        this.processIdentityProbe.forget(terminalId);
        this.lifecycleWatchdogs.forget(terminalId, true);
        this.launchIdsByTerminal.delete(terminalId);
        this.hookLaunches.forget(terminalId);
        this.forgetLifecycleState(terminalId);
    }

    /**
     * Applies only validated, provider-neutral lifecycle data. An attention-bearing signal makes hooks authoritative
     * for status; until then metadata remains a completion fallback when a later hook is lost, and it always owns
     * identity/title/usage. A parent completion claims authority even while child aggregation defers its lifecycle.
     */
    observeLifecycleSignal(signal: AgentLifecycleSignal): AgentSignalDecision {
        if (this.launchIdsByTerminal.get(signal.terminalId) !== signal.launchId)
            return 'staleLaunch';
        const terminal = this.database.getTerminal(signal.terminalId);
        if (!terminal) return 'terminalMissing';
        /**
         * Hook environment is inherited by every child of a Shell PTY so an alias-launched Agent can use it later. It
         * is not provider identity: only the independent foreground-process and metadata promotion paths may establish
         * that binding. For an already-bound Agent Terminal, a cross-provider signal is still strong evidence the user
         * launched a different agent in the same PTY (or that an agent ran nested inside another's tool), so it opens a
         * bounded switch candidate that only the foreground-process probe may confirm.
         */
        if (terminal.provider !== signal.provider) {
            const existing = this.shellPromotionCandidates.get(signal.terminalId);
            if (terminal.provider && (!existing || existing.provider !== signal.provider)) {
                const startedAt = Date.now();
                this.shellPromotionCandidates.set(signal.terminalId, {
                    agentSessionId: signal.agentSessionId,
                    attempts: 0,
                    expiresAt: startedAt + SHELL_PROMOTION_WINDOW_MS,
                    nextProcessProbeAt: 0,
                    origin: 'hook',
                    processProbes: 0,
                    provider: signal.provider,
                    startedAt,
                });
            }
            const candidate = this.shellPromotionCandidates.get(signal.terminalId);
            if (
                candidate &&
                candidate.expiresAt >= Date.now() &&
                (!candidate.provider || candidate.provider === signal.provider)
            ) {
                candidate.provider = signal.provider;
                candidate.origin = 'hook';
                if (signal.agentSessionId) candidate.agentSessionId = signal.agentSessionId;
                if (['turnStarted', 'turnFinished', 'attentionRequested'].includes(signal.phase))
                    candidate.lifecycleSignal = signal;
            }
            return 'providerMismatch';
        }
        const work = this.work.observe(signal);
        if (work.outcome !== undefined) return work.outcome;
        if (signal.phase === 'turnFinished')
            this.hookLaunches.markAuthoritative(signal.terminalId, signal.launchId);
        const isToolBatchFinished = signal.phase === 'toolBatchFinished';
        const didResolveAttention =
            isToolBatchFinished && this.attention.resolvesFinalRequest(signal);
        if (signal.phase === 'compactionStarted')
            this.lifecycleWatchdogs.startCompaction(signal.terminalId);
        /**
         * SessionStart also fires when Codex resumes after compaction. It identifies the thread but does not prove that
         * the operation ended, so clearing here would briefly hide the compaction state before PostCompact arrives.
         */
        else if (signal.phase !== 'sessionIdentified')
            this.lifecycleWatchdogs.clearCompaction(signal.terminalId);
        switch (signal.phase) {
            case 'turnStarted': {
                this.hookLaunches.markTurnStarted(signal.terminalId, signal.launchId);
                this.attention.forget(signal.terminalId);
                this.metadataActivityBaselines.set(signal.terminalId, null);
                if (signal.provider === 'codex' && signal.agentTurnId)
                    this.lifecycleWatchdogs.startRunningTurn(
                        signal.terminalId,
                        signal.launchId,
                        signal.agentTurnId,
                    );
                else this.lifecycleWatchdogs.stopRunningTurn(signal.terminalId);
                break;
            }
            case 'attentionRequested': {
                this.attention.request(signal);
                this.lifecycleWatchdogs.stopRunningTurn(signal.terminalId);
                this.hookLaunches.markAuthoritative(signal.terminalId, signal.launchId);
                break;
            }
            // No default
        }
        /**
         * A signal naming a different provider session proves the user resumed inside the running Terminal (a path no
         * Caxri-managed launch reset ever sees), so identity is rebound here and the scheduled probe republishes the
         * resumed session's title.
         */
        let shouldRefreshMetadata =
            signal.phase === 'sessionIdentified' && Boolean(signal.agentSessionId);
        if (
            signal.agentSessionId &&
            signal.agentSessionId !== terminal.agentSessionId &&
            this.database.rebindAgentSession(
                signal.terminalId,
                signal.provider,
                signal.agentSessionId,
            )
        ) {
            /**
             * Invalidate any in-flight probe for the previous session so its late result cannot write the old identity
             * and title back over the rebound one.
             */
            this.probeGenerations.set(
                signal.terminalId,
                (this.probeGenerations.get(signal.terminalId) ?? 0) + 1,
            );
            shouldRefreshMetadata = true;
        }
        if (shouldRefreshMetadata) this.refreshes.schedule(signal.terminalId);
        if (!work.deferCompletion && (!isToolBatchFinished || didResolveAttention))
            this.applyLifecycle(signal);
        return 'accepted';
    }

    /**
     * Drops hook authority when installation health proves the provider definition is no longer current.
     */
    resetHookAuthority(provider: AgentProvider): void {
        for (const terminal of this.database.listTerminals())
            if (terminal.provider === provider) {
                this.hookLaunches.forget(terminal.id);
                this.forgetLifecycleState(terminal.id);
                this.lifecycleWatchdogs.forget(terminal.id, true);
            }
    }

    /**
     * Starts a fresh correlation window before a new Agent process can see historical metadata.
     */
    prepareTerminalStart(terminalId: string): void {
        const terminal = this.database.getTerminal(terminalId);
        if (!terminal?.provider) return;
        /**
         * Invalidate probes started for the previous process before clearing its durable binding.
         */
        this.probeGenerations.set(terminalId, (this.probeGenerations.get(terminalId) ?? 0) + 1);
        this.shellInputs.delete(terminalId);
        this.shellPromotionCandidates.delete(terminalId);
        this.shellProcessProbe.cancel(terminalId);
        this.processIdentityProbe.forget(terminalId);
        const startedAt = Date.now();
        const excluded = new Set(this.excludedAgentSessionIdsByTerminal.get(terminalId));
        if (terminal.agentSessionId) excluded.add(terminal.agentSessionId);
        this.excludedAgentSessionIdsByTerminal.set(terminalId, excluded);
        this.startedAtByTerminal.set(terminalId, startedAt);
        this.metadataActivityBaselines.delete(terminalId);
        this.forgetLifecycleState(terminalId);
        this.database.resetAgentMetadataForStart(terminalId, startedAt);
    }

    /**
     * Starts a new process generation while preserving the Agent session it will resume.
     */
    prepareTerminalResume(terminalId: string): void {
        const terminal = this.database.getTerminal(terminalId);
        if (!terminal?.provider) return;
        this.probeGenerations.set(terminalId, (this.probeGenerations.get(terminalId) ?? 0) + 1);
        this.refreshes.cancel(terminalId);
        this.shellProcessProbe.cancel(terminalId);
        this.processIdentityProbe.forget(terminalId);
        this.shellInputs.delete(terminalId);
        this.startedAtByTerminal.set(terminalId, Date.now());
        this.metadataActivityBaselines.delete(terminalId);
        this.forgetLifecycleState(terminalId);
    }

    /**
     * Immediately probes a Terminal after start or restart.
     */
    probeTerminal(terminalId: string): void {
        /**
         * `probe` handles failures internally; synchronous callers cannot await it.
         */
        // eslint-disable-next-line no-void -- see comment above; awaiting is not possible here
        void this.probe(terminalId);
    }

    probeTerminalNow(terminalId: string): Promise<void> {
        return this.probe(terminalId);
    }

    probeSessionPrimaryAgent(sessionId: string): void {
        const session = this.database.getSession(sessionId);
        if (session?.primaryAgentTerminalId) this.probeTerminal(session.primaryAgentTerminalId);
    }

    /**
     * Drops a pending refresh for a Terminal whose durable record is about to disappear.
     */
    forgetTerminal(terminalId: string): void {
        this.lifecycleWatchdogs.forget(terminalId);
        this.refreshes.cancel(terminalId);
        this.shellProcessProbe.cancel(terminalId);
        this.excludedAgentSessionIdsByTerminal.delete(terminalId);
        this.shellInputs.delete(terminalId);
        this.shellPromotionCandidates.delete(terminalId);
        this.processIdentityProbe.forget(terminalId);
        this.startedAtByTerminal.delete(terminalId);
        this.metadataActivityBaselines.delete(terminalId);
        this.probeGenerations.delete(terminalId);
        this.launchIdsByTerminal.delete(terminalId);
        this.hookLaunches.forget(terminalId);
        this.forgetLifecycleState(terminalId);
    }

    forgetSession(sessionId: string): void {
        for (const terminal of this.database.listTerminals(sessionId))
            this.forgetTerminal(terminal.id);
    }

    close(): void {
        this.refreshes.close();
        this.shellProcessProbe.close();
        this.shellInputs.clear();
        this.shellPromotionCandidates.clear();
        this.processIdentityProbe.clear();
        this.probeGenerations.clear();
        this.launchIdsByTerminal.clear();
        this.hookLaunches.clear();
        this.attention.clear();
        this.work.clear();
        this.metadataActivityBaselines.clear();
        this.lifecycleWatchdogs.close();
    }
}

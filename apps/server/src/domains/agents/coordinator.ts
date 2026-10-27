import type { AgentOperation, AgentProvider, ServerEvent, TerminalRecord } from '@caxri/protocol';
import { errorMessage, isChatTerminal } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import { CoalescedScheduler } from '../coalesced-scheduler';
import type { CaxriDatabase } from '../db';
import { AgentAttentionTracker } from './attention-tracker';
import { agentProviderStateRoot } from './contract';
import {
    AGENT_COMPACTION_TIMEOUT_MS,
    AGENT_METADATA_REFRESH_DELAY_MS,
    AGENT_RUNNING_WATCHDOG_INTERVAL_MS,
    MAX_SHELL_PROMOTION_PROBES,
} from './coordinator-constants';
import type { AgentCoordinatorOptions } from './coordinator-options';
import { createRecoveringHookLaunchTracker } from './hook-launch-tracker';
import { CodexHookSessionRebindTracker } from './hook-session-rebind';
import type { AgentLifecycleSignal, AgentSignalDecision } from './hooks/contract';
import { AgentIdleProof } from './idle-proof';
import { AgentLifecycleProjection } from './lifecycle-projection';
import { AgentLifecycleWatchdogs, isStandaloneEscape } from './lifecycle-watchdogs';
import { AgentMaintenanceTurns } from './maintenance-turns';
import type { MetadataActivityBaseline } from './metadata-activity-baseline';
import { probeActivity } from './metadata-activity-baseline';
import { ProbeQueue } from './probe-queue';
import { detectForegroundAgentProvider } from './process-detection';
import { ProcessIdentityProbe } from './process-identity-probe';
// oxlint-disable-next-line react-doctor/no-barrel-import -- Provider clusters require a public barrel.
import { GrokTurnTracker } from './providers/grok';
import type { AgentService } from './service';
import { ShellProcessProbe } from './shell-process-probe';
import type { ShellInputState, ShellPromotionCandidate } from './shell-promotion';
import {
    decideInputPromotionCandidate,
    scanShellInput,
    SHELL_PROMOTION_WINDOW_MS,
} from './shell-promotion';
import { AgentWorkTracker } from './work-tracker';

/**
 * Single owner of Agent metadata probing. It decides which Terminals are Agent Terminals, schedules the trailing
 * refresh their output implies, and runs the immediate probes that Session and Terminal lifecycle changes require, so
 * no other module needs to track Agent Terminal identity.
 */
export class AgentCoordinator {
    private readonly lifecycle: AgentLifecycleProjection;
    private readonly lifecycleWatchdogs: AgentLifecycleWatchdogs;
    private readonly excludedAgentSessionIdsByTerminal = new Map<string, Set<string>>();
    private readonly refreshes: CoalescedScheduler<string>;
    private readonly probes = new ProbeQueue((terminalId) => this.probeOnce(terminalId));
    private readonly shellInputs = new Map<string, ShellInputState>();
    private readonly processIdentityProbe = new ProcessIdentityProbe();
    private readonly shellProcessProbe: ShellProcessProbe;
    private readonly shellPromotionCandidates = new Map<string, ShellPromotionCandidate>();
    private readonly startedAtByTerminal = new Map<string, number>();
    private readonly probeGenerations = new Map<string, number>();
    private readonly launchIdsByTerminal = new Map<string, string>();
    private readonly hookLaunches: ReturnType<typeof createRecoveringHookLaunchTracker>;
    private readonly hookSessionRebinds: CodexHookSessionRebindTracker;
    private readonly attention = new AgentAttentionTracker();
    private readonly idleProof = new AgentIdleProof();
    private readonly work = new AgentWorkTracker(
        (signal) => this.lifecycle.apply(signal, 'deferredHook'),
        { onWaitingChange: (terminalId) => this.lifecycle.emitMetadataChange(terminalId) },
    );
    /**
     * A `null` provider metadata baseline marks a real transition.
     */
    private readonly metadataActivityBaselines = new Map<string, MetadataActivityBaseline | null>();
    private readonly grokTurns = new GrokTurnTracker();
    readonly maintenanceTurns: AgentMaintenanceTurns;

    constructor(
        private readonly database: CaxriDatabase,
        private readonly agents: AgentService,
        emit: (event: ServerEvent) => void,
        private readonly logger: StructuredLogger,
        private readonly options: AgentCoordinatorOptions = {},
    ) {
        this.hookLaunches = createRecoveringHookLaunchTracker(
            (terminalId, launchId) => this.launchIdsByTerminal.get(terminalId) === launchId,
            (terminalId) => this.probeTerminal(terminalId),
            logger,
            options.unknownRecoveryMs,
        );
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
            /**
             * Provider-bearing candidates stay until expiry for hook dedupe and Shell or switch metadata fallback.
             */
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
                this.lifecycle.emitMetadataChange(terminalId);
            },
        });
        this.refreshes = new CoalescedScheduler(
            options.refreshDelayMs ?? AGENT_METADATA_REFRESH_DELAY_MS,
            (terminalId: string) => this.probes.probe(terminalId),
        );
        this.hookSessionRebinds = new CodexHookSessionRebindTracker(
            database,
            agents,
            (terminalId) => this.launchIdsByTerminal.get(terminalId),
            (terminalId) => this.processIdentityProbe.currentPid(terminalId),
            (terminalId) => this.refreshes.schedule(terminalId),
        );
        const compactionTimeoutMs = options.compactionTimeoutMs ?? AGENT_COMPACTION_TIMEOUT_MS;
        this.maintenanceTurns = new AgentMaintenanceTurns(compactionTimeoutMs, logger);
        this.lifecycleWatchdogs = new AgentLifecycleWatchdogs(
            compactionTimeoutMs,
            options.runningWatchdogIntervalMs ?? AGENT_RUNNING_WATCHDOG_INTERVAL_MS,
            (terminalId) => this.lifecycle.emitMetadataChange(terminalId),
            async (terminalId, launchId) => {
                if (this.launchIdsByTerminal.get(terminalId) !== launchId) return false;
                await this.probes.probe(terminalId);
                const terminal = this.database.getTerminal(terminalId);
                return (
                    this.launchIdsByTerminal.get(terminalId) === launchId &&
                    terminal !== undefined &&
                    this.database.getSession(terminal.sessionId)?.agentActivityState === 'running'
                );
            },
        );
        this.lifecycle = new AgentLifecycleProjection(database, logger, emit, {
            idleProof: this.idleProof,
            attention: this.attention,
            watchdogs: this.lifecycleWatchdogs,
            hookLaunches: this.hookLaunches,
            onApplied: options.onLifecycleApplied,
            onActivityChanged: options.onSessionActivityChanged,
        });
    }

    private forgetLifecycleState(terminalId: string): void {
        this.hookSessionRebinds.forget(terminalId);
        this.grokTurns.forget(terminalId);
        this.idleProof.invalidate(terminalId);
        this.attention.forget(terminalId);
        this.work.forget(terminalId);
        this.maintenanceTurns.end(terminalId, 'retired');
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
        this.lifecycle.emitMetadataChange(terminalId);
        if (candidate.lifecycleSignal) this.observeLifecycleSignal(candidate.lifecycleSignal);
        this.refreshes.schedule(terminalId);
        return true;
    }

    /**
     * Runs one serialized observation. {@link ProbeQueue} preserves a trailing read requested while this one is in
     * flight.
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
            const isChat = isChatTerminal(terminal);
            // A Chat binds its Agent Session from its own protocol; working-directory discovery could otherwise claim
            // an unrelated PTY conversation before the Chat's first turn creates one.
            if (isChat && !terminal.agentSessionId) return;
            if (!isChat && (await this.probeProviderSwitch(terminal))) return;
            if (
                !isChat &&
                (await this.hookSessionRebinds.probe(
                    terminal,
                    this.startedAtByTerminal.get(terminal.id) ?? terminal.createdAt,
                ))
            ) {
                const generation = (this.probeGenerations.get(terminal.id) ?? 0) + 1;
                this.probeGenerations.set(terminal.id, generation);
                this.metadataActivityBaselines.set(terminal.id, null);
                this.refreshes.schedule(terminal.id);
                return;
            }
            const session = this.database.getSession(terminal.sessionId);
            if (!session) return;
            const excludedAgentSessionIds = [
                ...(this.excludedAgentSessionIdsByTerminal.get(terminal.id) ?? []),
                ...this.database.claimedAgentSessionIds(terminal.id),
            ];
            const agentTurnId = this.lifecycleWatchdogs.agentTurnId(terminal.id);
            const snapshot = await this.agents.snapshot(terminal.provider, {
                agentSessionId: terminal.agentSessionId,
                agentTurnId,
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
            // A maintenance compaction's running turn is as invisible to probes as to hooks.
            const isHookOwned =
                this.maintenanceTurns.holds(terminal.id) ||
                this.hookLaunches.ownsProbe(
                    terminal.id,
                    launchId,
                    snapshot.status,
                    agentTurnId === undefined &&
                        terminal.provider === 'codex' &&
                        snapshot.activitySource === 'latestTurn'
                        ? snapshot.activityTurnId
                        : undefined,
                );
            const { isRecordActivity, metadataSnapshot } = probeActivity(
                this.metadataActivityBaselines,
                terminal.id,
                snapshot,
                currentSession.agentActivityState,
                isHookOwned,
            );
            if (
                this.lifecycle.recordActivity({
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
                this.lifecycle.emitMetadataChange(terminal.id);
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
        const snapshot = await this.probeCandidate(terminal, candidate, 'provider-switch');
        if (!snapshot) return false;
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
        this.lifecycle.emitMetadataChange(terminal.id);
        this.refreshes.schedule(terminal.id);
        return true;
    }

    /**
     * One provider snapshot for an input-opened candidate. Returns `undefined` when the candidate was replaced,
     * cleared, or expired while the snapshot was in flight, so a stale result can never confirm it.
     */
    private async probeCandidate(
        terminal: TerminalRecord,
        candidate: ShellPromotionCandidate,
        purpose: 'provider-switch' | 'shell-promotion',
    ) {
        const { provider } = candidate;
        if (!provider) return;
        candidate.attempts += 1;
        const snapshot = await this.agents.snapshot(provider, {
            correlationId: `${terminal.id}:${purpose}:${candidate.startedAt}`,
            excludedAgentSessionIds: this.database.claimedAgentSessionIdsForProvider(
                provider,
                terminal.id,
            ),
            rootPath: agentProviderStateRoot(terminal),
            processState: terminal.lastProcessState,
            startedAt: candidate.startedAt,
        });
        const current = this.shellPromotionCandidates.get(terminal.id);
        if (current !== candidate || current.origin !== 'input' || candidate.expiresAt < Date.now())
            return;
        return snapshot;
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
        const snapshot = await this.probeCandidate(terminal, candidate, 'shell-promotion');
        if (!snapshot) return;
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
        this.lifecycle.emitMetadataChange(terminal.id);
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

    agentOperation(terminalId: string): AgentOperation | undefined {
        return this.lifecycleWatchdogs.operation(terminalId) ?? this.work.operation(terminalId);
    }

    /**
     * Both a delivered SIGINT and standalone Escape release hook ownership and request current evidence.
     */
    observeInterrupt(terminalId: string, launchId?: string): void {
        if (launchId !== undefined && this.launchIdsByTerminal.get(terminalId) !== launchId) return;
        const wasCompacting = this.lifecycleWatchdogs.clearCompaction(terminalId);
        const released = this.hookLaunches.markTurnInterrupted(
            terminalId,
            launchId === undefined ? 'escape' : 'signal',
            this.attention.forget(terminalId),
        );
        if (launchId !== undefined) this.options.onSignalInterrupt?.(terminalId);
        if (released || wasCompacting || launchId !== undefined) this.probeTerminal(terminalId);
    }

    /**
     * Tracks unpublished input without logging or persistence. Direct Agent commands create candidates; editing escape
     * sequences disable detection until submission. Provider metadata must confirm a candidate before identity
     * changes.
     */
    observeInput(terminalId: string, data: string): boolean {
        let state = this.shellInputs.get(terminalId);
        if (!state) {
            if (!this.database.getTerminal(terminalId)) return false;
            state = { command: '', isBracketedPaste: false, valid: true };
        }
        if (isStandaloneEscape(data)) this.observeInterrupt(terminalId);
        const scan = scanShellInput(state, data, {
            onDiscard: () => this.shellPromotionCandidates.delete(terminalId),
            onSubmit: (command) => this.openPromotionCandidate(terminalId, command),
        });
        this.shellInputs.set(terminalId, scan.state);
        return scan.didSubmit;
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

    hasIdleProof(terminalId: string, launchId: string, turnId: string): boolean {
        return (
            this.isCurrentTerminalLaunch(terminalId, launchId) &&
            this.idleProof.matches(terminalId, launchId, turnId)
        );
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
                if (
                    ['turnStarted', 'turnFinished', 'turnFailed', 'attentionRequested'].includes(
                        signal.phase,
                    )
                )
                    candidate.lifecycleSignal = signal;
            }
            return 'providerMismatch';
        }
        if (!this.grokTurns.accept(signal, terminal.agentSessionId)) return 'staleProviderTurn';
        // Accepted continuation evidence must not mark the Session idle or complete.
        if (signal.agentTurnContinues) return 'accepted';
        if (this.maintenanceTurns.absorb(signal)) return 'maintenanceTurn';
        this.idleProof.invalidate(signal.terminalId);
        const work = this.work.observe(signal);
        if (work.outcome !== 'subagentUnmatched')
            this.hookLaunches.observeEvidence(signal.terminalId, signal.launchId);
        if (work.outcome !== undefined) return work.outcome;
        if (signal.phase === 'turnFinished')
            this.hookLaunches.markAuthoritative(
                signal.terminalId,
                signal.launchId,
                signal.agentTurnId,
            );
        const canApplyLifecycle = this.attention.allowsLifecycle(signal);
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
        // Provider-specific identity authority fences in-terminal switches from inherited child hooks.
        let shouldRefreshMetadata =
            signal.phase === 'sessionIdentified' && Boolean(signal.agentSessionId);
        if (
            !this.hookSessionRebinds.defer(signal, terminal) &&
            signal.agentSessionId &&
            signal.agentSessionId !== terminal.agentSessionId &&
            this.database.rebindAgentSession(
                signal.terminalId,
                signal.provider,
                signal.agentSessionId,
            )
        ) {
            this.probeGenerations.set(
                signal.terminalId,
                (this.probeGenerations.get(signal.terminalId) ?? 0) + 1,
            );
            this.metadataActivityBaselines.set(signal.terminalId, null);
            shouldRefreshMetadata = true;
        }
        if (shouldRefreshMetadata) this.refreshes.schedule(signal.terminalId);
        if (canApplyLifecycle && !work.deferCompletion)
            this.lifecycle.apply({ ...signal, agentContinuedTurnId: work.continuedTurnId });
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

    prepareTerminalResume(terminalId: string): void {
        const terminal = this.database.getTerminal(terminalId);
        if (!terminal?.provider) return;
        this.probeGenerations.set(terminalId, (this.probeGenerations.get(terminalId) ?? 0) + 1);
        this.refreshes.cancel(terminalId);
        this.shellProcessProbe.cancel(terminalId);
        this.processIdentityProbe.forget(terminalId);
        this.shellInputs.delete(terminalId);
        this.startedAtByTerminal.set(terminalId, Date.now());
        this.metadataActivityBaselines.set(terminalId, null);
        this.forgetLifecycleState(terminalId);
    }

    probeTerminal(terminalId: string): void {
        void this.probes.probe(terminalId);
    }

    probeTerminalNow(terminalId: string): Promise<void> {
        return this.probes.probe(terminalId);
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

    async close(): Promise<void> {
        this.refreshes.close();
        this.shellProcessProbe.close();
        this.shellInputs.clear();
        this.shellPromotionCandidates.clear();
        this.processIdentityProbe.clear();
        this.probeGenerations.clear();
        this.launchIdsByTerminal.clear();
        this.hookLaunches.clear();
        this.hookSessionRebinds.clear();
        this.idleProof.clear();
        this.attention.clear();
        this.work.clear();
        this.maintenanceTurns.clear();
        this.metadataActivityBaselines.clear();
        this.lifecycleWatchdogs.close();
        await this.probes.close();
    }
}

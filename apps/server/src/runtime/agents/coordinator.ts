import type { AgentOperation, AgentProvider, RuntimeEvent, TerminalRecord } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds, errorMessage } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import { CoalescedScheduler } from '../coalesced-scheduler';
import type { CaxriDatabase } from '../db';
import type { AgentLifecycleSignal } from './hooks/contract';
import { detectForegroundAgentProvider } from './process-detection';
import type { AgentService } from './service';

const AGENT_METADATA_REFRESH_DELAY_MS = 2_000;
const AGENT_COMPACTION_TIMEOUT_MS = 5 * 60_000;
const MAX_SHELL_COMMAND_LENGTH = 4_096;
const MAX_SHELL_PROCESS_PROBES = 5;
const MAX_SHELL_PROMOTION_PROBES = 3;
const SHELL_PROCESS_PROBE_INTERVAL_MS = 1_000;
const SHELL_PROMOTION_WINDOW_MS = 30_000;

interface ShellInputState {
    command: string;
    valid: boolean;
}

interface ShellPromotionCandidate {
    /**
     * Provider session reported by the cross-provider hook signal that opened this switch candidate. A hook-opened
     * candidate starts too late for the `startedAt` metadata filter to see the already-running session, so this is the
     * only identity a confirmed switch can adopt immediately.
     */
    agentSessionId?: string;
    attempts: number;
    expiresAt: number;
    nextProcessProbeAt: number;
    /**
     * How the candidate was opened. Only an input-opened candidate (the user submitted a command at the prompt) may be
     * confirmed by provider metadata: hook signals are inherited by nested agent tool-calls, which also create real
     * provider sessions in the same cwd, so a hook-opened candidate must wait for the foreground-process probe.
     */
    origin: 'hook' | 'input';
    processProbes: number;
    provider?: AgentProvider;
    startedAt: number;
}

const providerByExecutableName = new Map<string, AgentProvider>(
    agentProviderIds.map((provider) => [agentProviderCatalog[provider].executableName, provider]),
);

function directAgentProvider(command: string): AgentProvider | undefined {
    const normalized = command.trim();
    if (/[;&|<>]/.test(normalized)) return undefined;
    const executable = normalized.match(/^(\S+)/)?.[1];
    const basename = executable?.split(/[\\/]/).at(-1);
    return basename ? providerByExecutableName.get(basename) : undefined;
}

function canInspectShellLaunch(command: string): boolean {
    const normalized = command.trim();
    return Boolean(normalized) && !/[;&|<>]/.test(normalized);
}

export interface AgentCoordinatorOptions {
    /**
     * Trailing delay before Agent Terminal output refreshes durable Agent metadata.
     */
    refreshDelayMs?: number;
    /**
     * Safety bound for a lost `PostCompact` signal. Production uses five minutes; tests may shorten it.
     */
    compactionTimeoutMs?: number;
    /**
     * Test seam for the bounded foreground-process probe used to resolve shell aliases.
     */
    detectForegroundAgent?: (shellPid: number) => Promise<AgentProvider | undefined>;
}

/**
 * Single owner of Agent metadata probing. It decides which Terminals are Agent Terminals, schedules the trailing
 * refresh their output implies, and runs the immediate probes that Session and Terminal lifecycle changes require, so
 * no other module needs to track Agent Terminal identity.
 */
export class AgentCoordinator {
    private readonly agentOperations = new Map<string, AgentOperation>();
    private readonly agentOperationTimeouts = new Map<string, NodeJS.Timeout>();
    private readonly compactionTimeoutMs: number;
    private readonly excludedAgentSessionIdsByTerminal = new Map<string, Set<string>>();
    private readonly detectForegroundAgent: (
        shellPid: number,
    ) => Promise<AgentProvider | undefined>;
    private readonly refreshes: CoalescedScheduler<string>;
    private readonly shellInputs = new Map<string, ShellInputState>();
    private readonly shellProcessDetections = new Map<string, ShellPromotionCandidate>();
    private readonly shellPromotionCandidates = new Map<string, ShellPromotionCandidate>();
    private readonly startedAtByTerminal = new Map<string, number>();
    private readonly probeGenerations = new Map<string, number>();
    private readonly launchIdsByTerminal = new Map<string, string>();
    private readonly hookAuthoritativeLaunchIds = new Map<string, string>();

    constructor(
        private readonly database: CaxriDatabase,
        private readonly agents: AgentService,
        private readonly emit: (event: RuntimeEvent) => void,
        private readonly logger: StructuredLogger,
        options: AgentCoordinatorOptions = {},
    ) {
        this.compactionTimeoutMs = options.compactionTimeoutMs ?? AGENT_COMPACTION_TIMEOUT_MS;
        this.detectForegroundAgent = options.detectForegroundAgent ?? detectForegroundAgentProvider;
        this.refreshes = new CoalescedScheduler(
            options.refreshDelayMs ?? AGENT_METADATA_REFRESH_DELAY_MS,
            (terminalId: string) => this.probe(terminalId),
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

    private clearAgentOperation(terminalId: string, shouldEmitChange = true): void {
        const timeout = this.agentOperationTimeouts.get(terminalId);
        if (timeout) clearTimeout(timeout);
        this.agentOperationTimeouts.delete(terminalId);
        const hadOperation = this.agentOperations.delete(terminalId);
        if (!shouldEmitChange || !hadOperation) return;
        this.emitAgentMetadataChange(terminalId);
    }

    private startCompaction(terminalId: string): void {
        const existingTimeout = this.agentOperationTimeouts.get(terminalId);
        if (existingTimeout) clearTimeout(existingTimeout);
        const wasCompacting = this.agentOperations.get(terminalId) === 'compacting';
        this.agentOperations.set(terminalId, 'compacting');
        const timeout = setTimeout(
            () => this.clearAgentOperation(terminalId),
            this.compactionTimeoutMs,
        );
        timeout.unref();
        this.agentOperationTimeouts.set(terminalId, timeout);
        if (!wasCompacting) this.emitAgentMetadataChange(terminalId);
    }

    /**
     * Every simple command opens a promotion window, and chatty commands (dev servers, tails) emit output for the whole
     * window, so process inspection must be bounded per candidate: at most `MAX_SHELL_PROCESS_PROBES` spaced probes,
     * after which an alias candidate (no direct provider) is dropped because nothing else can ever promote it.
     */
    private async detectShellPromotion(
        terminalId: string,
        shellPid: number,
        candidate: ShellPromotionCandidate,
    ): Promise<void> {
        if (this.shellProcessDetections.get(terminalId) === candidate) return;
        const now = Date.now();
        if (now < candidate.nextProcessProbeAt) return;
        if (candidate.processProbes >= MAX_SHELL_PROCESS_PROBES) {
            if (!candidate.provider) this.shellPromotionCandidates.delete(terminalId);
            return;
        }
        candidate.processProbes += 1;
        candidate.nextProcessProbeAt = now + SHELL_PROCESS_PROBE_INTERVAL_MS;
        this.shellProcessDetections.set(terminalId, candidate);
        try {
            const provider = await this.detectForegroundAgent(shellPid);
            if (
                !provider ||
                this.shellPromotionCandidates.get(terminalId) !== candidate ||
                candidate.expiresAt < Date.now() ||
                (candidate.provider && candidate.provider !== provider)
            ) {
                return;
            }
            const terminal = this.database.getTerminal(terminalId);
            /**
             * The foreground agent matching the bound provider means nothing changed; keep the bounded candidate
             * running in case the actual switch lands within its window.
             */
            if (!terminal || terminal.provider === provider) return;
            if (terminal.provider) {
                if (!this.database.switchAgentProvider(terminalId, provider)) return;
                /**
                 * Invalidate in-flight probes for the previous provider and drop its hook status authority so a late
                 * result cannot republish the old identity over the switched one.
                 */
                this.probeGenerations.set(
                    terminalId,
                    (this.probeGenerations.get(terminalId) ?? 0) + 1,
                );
                this.hookAuthoritativeLaunchIds.delete(terminalId);
                if (candidate.agentSessionId)
                    this.database.rebindAgentSession(
                        terminalId,
                        provider,
                        candidate.agentSessionId,
                    );
            } else if (!this.database.promoteShellToAgent(terminalId, provider)) {
                return;
            }
            this.shellInputs.delete(terminalId);
            this.shellPromotionCandidates.delete(terminalId);
            this.startedAtByTerminal.set(terminalId, candidate.startedAt);
            this.emitAgentMetadataChange(terminalId);
            this.refreshes.schedule(terminalId);
        } catch (error) {
            /**
             * Process inspection is a recoverable capability miss; direct metadata probing remains available.
             */
            this.logger.write('warn', logEventCatalog.agent.processProbeFailed, {
                fields: { terminalId, error: errorMessage(error, 'unknown') },
            });
        } finally {
            if (this.shellProcessDetections.get(terminalId) === candidate)
                this.shellProcessDetections.delete(terminalId);
        }
    }

    private async probe(terminalId: string, shouldRetryClaim = true): Promise<void> {
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
                correlationId: terminal.id,
                excludedAgentSessionIds,
                rootPath: terminal.cwd,
                processState: terminal.lastProcessState,
                startedAt: this.startedAtByTerminal.get(terminal.id) ?? terminal.createdAt,
            });
            if ((this.probeGenerations.get(terminalId) ?? 0) !== generation) return;
            if (
                snapshot.sessionId &&
                this.database.isAgentSessionClaimedByOtherTerminal(terminal.id, snapshot.sessionId)
            ) {
                if (shouldRetryClaim) await this.probe(terminalId, false);
                return;
            }
            const currentSession = this.database.getSession(terminal.sessionId);
            if (!currentSession) return;
            const hookLaunchId = this.hookAuthoritativeLaunchIds.get(terminal.id);
            const isHookAuthoritative =
                hookLaunchId !== undefined &&
                hookLaunchId === this.launchIdsByTerminal.get(terminal.id);
            const metadataSnapshot = isHookAuthoritative
                ? {
                      ...snapshot,
                      attentionKind: undefined,
                      status: currentSession.lastActivityState,
                  }
                : snapshot;
            if (this.database.updateAgentMetadata(terminal.id, metadataSnapshot))
                this.emitAgentMetadataChange(terminal.id);
        } catch (error) {
            /**
             * A failed probe degrades Agent metadata to unknown; it never interrupts the Runtime.
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
            rootPath: terminal.cwd,
            processState: terminal.lastProcessState,
            startedAt: candidate.startedAt,
        });
        if (
            this.shellPromotionCandidates.get(terminal.id) !== candidate ||
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
        if (!this.database.switchAgentProvider(terminal.id, provider)) return false;
        /**
         * Invalidate in-flight probes for the previous provider and drop its hook status authority so a late result
         * cannot republish the old identity over the switched one.
         */
        this.probeGenerations.set(terminal.id, (this.probeGenerations.get(terminal.id) ?? 0) + 1);
        this.hookAuthoritativeLaunchIds.delete(terminal.id);
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
        if (!candidate?.provider || terminal.kind !== 'shell') return;
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
            rootPath: terminal.cwd,
            processState: terminal.lastProcessState,
            startedAt: candidate.startedAt,
        });
        if (
            this.shellPromotionCandidates.get(terminal.id) !== candidate ||
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
            if (shouldRetryClaim) await this.probe(terminal.id, false);
            return;
        }
        this.shellInputs.delete(terminal.id);
        this.shellPromotionCandidates.delete(terminal.id);
        this.startedAtByTerminal.set(terminal.id, candidate.startedAt);
        this.emitAgentMetadataChange(terminal.id);
    }

    /**
     * Opens a bounded promotion (or provider-switch) candidate for one submitted command line. A Shell accepts any
     * inspectable command; an already-bound Agent Terminal accepts only a direct different-provider command, and the
     * independent foreground-process probe must still confirm the running agent actually changed before durable
     * identity moves.
     */
    private openPromotionCandidate(terminalId: string, command: string): void {
        const terminal = this.database.getTerminal(terminalId);
        if (!terminal) return;
        const startedAt = Date.now();
        if (terminal.provider) {
            /**
             * After the bound agent exits, the user can relaunch a different agent through an alias or a history
             * recall, so any inspectable command opens a switch candidate. The foreground-process probe (or, for a
             * direct different-provider command, its metadata fallback) must still confirm before identity moves; a
             * same-provider or unconfirmed command changes nothing.
             */
            if (!canInspectShellLaunch(command)) {
                this.shellPromotionCandidates.delete(terminalId);
                return;
            }
            const provider = directAgentProvider(command);
            if (provider === terminal.provider) return;
            this.shellPromotionCandidates.set(terminalId, {
                attempts: 0,
                expiresAt: startedAt + SHELL_PROMOTION_WINDOW_MS,
                nextProcessProbeAt: 0,
                origin: 'input',
                processProbes: 0,
                provider,
                startedAt,
            });
            if (provider) this.refreshes.schedule(terminalId);
            return;
        }
        if (canInspectShellLaunch(command)) {
            const provider = directAgentProvider(command);
            this.shellPromotionCandidates.set(terminalId, {
                attempts: 0,
                expiresAt: startedAt + SHELL_PROMOTION_WINDOW_MS,
                nextProcessProbeAt: 0,
                origin: 'input',
                processProbes: 0,
                provider,
                startedAt,
            });
            if (provider) this.refreshes.schedule(terminalId);
        } else {
            this.shellPromotionCandidates.delete(terminalId);
        }
    }

    /**
     * Returns the current Runtime-only Agent subphase projected onto a Terminal read model.
     */
    agentOperation(terminalId: string): AgentOperation | undefined {
        return this.agentOperations.get(terminalId);
    }

    /**
     * Tracks only the current unpublished input line and never logs or persists it. Detection is intentionally
     * conservative: a direct `claude` or `codex` command creates a short-lived candidate, while shell editing escape
     * sequences disable detection until the next submission. Provider metadata must still confirm the launch before
     * durable Terminal identity changes.
     */
    observeInput(terminalId: string, data: string): void {
        let state = this.shellInputs.get(terminalId);
        if (!state) {
            const terminal = this.database.getTerminal(terminalId);
            if (!terminal) return;
            state = { command: '', valid: true };
        }
        const normalized = data.replaceAll('\u{1B}[200~', '').replaceAll('\u{1B}[201~', '');
        for (const character of normalized) {
            if (character === '\r' || character === '\n') {
                if (state.valid && state.command.trim())
                    this.openPromotionCandidate(terminalId, state.command);
                state = { command: '', valid: true };
                continue;
            }
            if (character === '\u{3}' || character === '\u{15}') {
                state = { command: '', valid: true };
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
    }

    /**
     * Agent membership normally comes from the durable provider. A Shell with a simple-command candidate first confirms
     * its foreground process; direct commands retain metadata probing as a fallback when process inspection is
     * unavailable.
     */
    observeOutput(terminalId: string, shellPid?: number): void {
        const terminal = this.database.getTerminal(terminalId);
        if (!terminal) return;
        const candidate = this.shellPromotionCandidates.get(terminalId);
        const isCandidateLive = candidate !== undefined && candidate.expiresAt >= Date.now();
        if (candidate && !isCandidateLive) this.shellPromotionCandidates.delete(terminalId);
        if (isCandidateLive && shellPid !== undefined) {
            /**
             * `detectShellPromotion` catches and logs its own errors internally, so this promise never rejects.
             * `observeOutput` is a synchronous PTY output hook and cannot await it.
             */
            // eslint-disable-next-line no-void -- see comment above; awaiting is not possible here
            void this.detectShellPromotion(terminalId, shellPid, candidate);
        }
        if (!terminal.provider && !(isCandidateLive && candidate.provider)) return;
        this.refreshes.schedule(terminalId);
    }

    /**
     * Establishes the opaque PTY generation that every accepted hook signal must match.
     */
    beginTerminalLaunch(terminalId: string, launchId: string): void {
        this.clearAgentOperation(terminalId);
        this.launchIdsByTerminal.set(terminalId, launchId);
        this.hookAuthoritativeLaunchIds.delete(terminalId);
    }

    /**
     * Ends lifecycle authority for a retired PTY before a replacement generation can start.
     */
    endTerminalLaunch(terminalId: string): void {
        this.clearAgentOperation(terminalId);
        this.launchIdsByTerminal.delete(terminalId);
        this.hookAuthoritativeLaunchIds.delete(terminalId);
    }

    /**
     * Applies only validated, provider-neutral lifecycle data. An attention-bearing signal makes hooks authoritative
     * for status; until then metadata remains a completion fallback when a later hook is lost, and it always owns
     * identity/title/usage.
     */
    observeLifecycleSignal(signal: AgentLifecycleSignal): boolean {
        if (this.launchIdsByTerminal.get(signal.terminalId) !== signal.launchId) return false;
        const terminal = this.database.getTerminal(signal.terminalId);
        if (!terminal) return false;
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
            } else if (
                terminal.provider &&
                existing?.provider === signal.provider &&
                signal.agentSessionId
            ) {
                existing.agentSessionId = signal.agentSessionId;
            }
            return false;
        }
        if (signal.phase === 'compactionStarted') this.startCompaction(signal.terminalId);
        else this.clearAgentOperation(signal.terminalId);
        if (signal.phase === 'turnStarted')
            this.hookAuthoritativeLaunchIds.delete(signal.terminalId);
        else if (signal.phase === 'attentionRequested' || signal.phase === 'turnFinished')
            this.hookAuthoritativeLaunchIds.set(signal.terminalId, signal.launchId);
        /**
         * A signal naming a different provider session proves the user resumed inside the running Terminal (a path no
         * Caxri-managed launch reset ever sees), so identity is rebound here and the scheduled probe republishes the
         * resumed session's title.
         */
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
            this.refreshes.schedule(signal.terminalId);
        }
        const isUpdated = this.database.updateAgentLifecycle(signal);
        if (isUpdated) this.emitAgentMetadataChange(signal.terminalId);
        return true;
    }

    /**
     * Drops hook authority when installation health proves the provider definition is no longer current.
     */
    resetHookAuthority(provider: AgentProvider): void {
        for (const terminal of this.database.listTerminals())
            if (terminal.provider === provider) {
                this.hookAuthoritativeLaunchIds.delete(terminal.id);
                this.clearAgentOperation(terminal.id);
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
        this.shellProcessDetections.delete(terminalId);
        const startedAt = Date.now();
        const excluded = new Set(this.excludedAgentSessionIdsByTerminal.get(terminalId));
        if (terminal.agentSessionId) excluded.add(terminal.agentSessionId);
        this.excludedAgentSessionIdsByTerminal.set(terminalId, excluded);
        this.startedAtByTerminal.set(terminalId, startedAt);
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
        this.startedAtByTerminal.set(terminalId, Date.now());
    }

    /**
     * Probes now instead of waiting for output, for a Terminal that just started or restarted.
     */
    probeTerminal(terminalId: string): void {
        /**
         * `probe` always catches and logs its own errors internally, so this promise never rejects. This is a
         * fire-and-forget entry point called from synchronous Runtime dispatch paths that cannot become async without
         * changing their own public, sync contracts.
         */
        // eslint-disable-next-line no-void -- see comment above; awaiting is not possible here
        void this.probe(terminalId);
    }

    /**
     * Keeps a Session title current when its primary Agent Terminal changed or was promoted.
     */
    probeSessionPrimaryAgent(sessionId: string): void {
        const session = this.database.getSession(sessionId);
        if (session?.primaryAgentTerminalId) this.probeTerminal(session.primaryAgentTerminalId);
    }

    /**
     * Drops a pending refresh for a Terminal whose durable record is about to disappear.
     */
    forgetTerminal(terminalId: string): void {
        this.clearAgentOperation(terminalId, false);
        this.refreshes.cancel(terminalId);
        this.excludedAgentSessionIdsByTerminal.delete(terminalId);
        this.shellInputs.delete(terminalId);
        this.shellPromotionCandidates.delete(terminalId);
        this.shellProcessDetections.delete(terminalId);
        this.startedAtByTerminal.delete(terminalId);
        this.probeGenerations.delete(terminalId);
        this.launchIdsByTerminal.delete(terminalId);
        this.hookAuthoritativeLaunchIds.delete(terminalId);
    }

    forgetSession(sessionId: string): void {
        for (const terminal of this.database.listTerminals(sessionId)) {
            this.clearAgentOperation(terminal.id, false);
            this.refreshes.cancel(terminal.id);
            this.excludedAgentSessionIdsByTerminal.delete(terminal.id);
            this.shellInputs.delete(terminal.id);
            this.shellPromotionCandidates.delete(terminal.id);
            this.shellProcessDetections.delete(terminal.id);
            this.startedAtByTerminal.delete(terminal.id);
            this.probeGenerations.delete(terminal.id);
            this.launchIdsByTerminal.delete(terminal.id);
            this.hookAuthoritativeLaunchIds.delete(terminal.id);
        }
    }

    close(): void {
        this.refreshes.close();
        this.shellInputs.clear();
        this.shellPromotionCandidates.clear();
        this.shellProcessDetections.clear();
        this.probeGenerations.clear();
        this.launchIdsByTerminal.clear();
        this.hookAuthoritativeLaunchIds.clear();
        for (const timeout of this.agentOperationTimeouts.values()) clearTimeout(timeout);
        this.agentOperationTimeouts.clear();
        this.agentOperations.clear();
    }
}

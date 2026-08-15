import type { AgentProvider } from '../../shared/agents';
import { agentProviderCatalog, agentProviderIds } from '../../shared/agents';
import { errorMessage } from '../../shared/ipc/errors';
import type { RuntimeEvent } from '../../shared/ipc/events';
import type { StructuredLogger } from '../../shared/node/logger';
import type { TerminalRecord } from '../../shared/types';
import { CoalescedScheduler } from '../coalesced-scheduler';
import type { CaxriDatabase } from '../db';
import type { AgentLifecycleSignal } from './hooks/contract';
import { detectForegroundAgentProvider } from './process-detection';
import type { AgentService } from './service';

const AGENT_METADATA_REFRESH_DELAY_MS = 2_000;
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
    attempts: number;
    expiresAt: number;
    nextProcessProbeAt: number;
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
    Trailing delay before Agent Terminal output refreshes durable Agent metadata.
     */
    refreshDelayMs?: number;
    /**
    Test seam for the bounded foreground-process probe used to resolve shell aliases.
     */
    detectForegroundAgent?: (shellPid: number) => Promise<AgentProvider | undefined>;
}

/**
 * Single owner of Agent metadata probing. It decides which Terminals are Agent Terminals, schedules
 * the trailing refresh their output implies, and runs the immediate probes that Session and Terminal
 * lifecycle changes require, so no other module needs to track Agent Terminal identity.
 */
export class AgentCoordinator {
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

    /**
     * Every simple command opens a promotion window, and chatty commands (dev servers, tails) emit
     * output for the whole window, so process inspection must be bounded per candidate: at most
     * `MAX_SHELL_PROCESS_PROBES` spaced probes, after which an alias candidate (no direct provider)
     * is dropped because nothing else can ever promote it.
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
            if (!this.database.promoteShellToAgent(terminalId, provider)) return;
            this.shellInputs.delete(terminalId);
            this.shellPromotionCandidates.delete(terminalId);
            this.startedAtByTerminal.set(terminalId, candidate.startedAt);
            this.emitAgentMetadataChange(terminalId);
            this.refreshes.schedule(terminalId);
        } catch (error) {
            /**
            Process inspection is a recoverable capability miss; direct metadata probing remains available.
             */
            this.logger.write('warn', 'agent.process_probe_failed', {
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
            A failed probe degrades Agent metadata to unknown; it never interrupts the Runtime.
             */
            this.logger.write('warn', 'agent.probe_failed', {
                fields: {
                    terminalId,
                    error: errorMessage(error, 'unknown'),
                },
            });
        }
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
     * Tracks only the current unpublished Shell input line and never logs or persists it. Detection
     * is intentionally conservative: a direct `claude` or `codex` command creates a short-lived
     * candidate, while shell editing escape sequences disable detection until the next submission.
     * Provider metadata must still confirm the launch before durable Terminal identity changes.
     */
    observeInput(terminalId: string, data: string): void {
        if (this.startedAtByTerminal.has(terminalId)) return;
        let state = this.shellInputs.get(terminalId);
        if (!state) {
            const terminal = this.database.getTerminal(terminalId);
            if (!terminal || terminal.provider || terminal.kind !== 'shell') return;
            state = { command: '', valid: true };
        }
        const normalized = data.replaceAll('\u{1B}[200~', '').replaceAll('\u{1B}[201~', '');
        for (const character of normalized) {
            if (character === '\r' || character === '\n') {
                if (state.valid && state.command.trim()) {
                    if (canInspectShellLaunch(state.command)) {
                        const startedAt = Date.now();
                        const provider = directAgentProvider(state.command);
                        this.shellPromotionCandidates.set(terminalId, {
                            attempts: 0,
                            expiresAt: startedAt + SHELL_PROMOTION_WINDOW_MS,
                            nextProcessProbeAt: 0,
                            processProbes: 0,
                            provider,
                            startedAt,
                        });
                        if (provider) this.refreshes.schedule(terminalId);
                    } else {
                        this.shellPromotionCandidates.delete(terminalId);
                    }
                }
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
     * Agent membership normally comes from the durable provider. A Shell with a simple-command
     * candidate first confirms its foreground process; direct commands retain metadata probing as a
     * fallback when process inspection is unavailable.
     */
    observeOutput(terminalId: string, shellPid?: number): void {
        const terminal = this.database.getTerminal(terminalId);
        if (!terminal) return;
        if (!terminal.provider) {
            const candidate = this.shellPromotionCandidates.get(terminalId);
            if (!candidate) return;
            if (candidate.expiresAt < Date.now()) {
                this.shellPromotionCandidates.delete(terminalId);
                return;
            }
            if (shellPid !== undefined) {
                /**
                `detectShellPromotion` catches and logs its own errors internally, so this promise
                never rejects. `observeOutput` is a synchronous PTY output hook and cannot await it.
                 */
                // eslint-disable-next-line no-void -- see comment above; awaiting is not possible here
                void this.detectShellPromotion(terminalId, shellPid, candidate);
            }
            if (!candidate.provider) return;
        }
        this.refreshes.schedule(terminalId);
    }

    /**
    Establishes the opaque PTY generation that every accepted hook signal must match.
     */
    beginTerminalLaunch(terminalId: string, launchId: string): void {
        this.launchIdsByTerminal.set(terminalId, launchId);
        this.hookAuthoritativeLaunchIds.delete(terminalId);
    }

    /**
    Ends lifecycle authority for a retired PTY before a replacement generation can start.
     */
    endTerminalLaunch(terminalId: string): void {
        this.launchIdsByTerminal.delete(terminalId);
        this.hookAuthoritativeLaunchIds.delete(terminalId);
    }

    /**
     * Applies only validated, provider-neutral lifecycle data. An attention-bearing signal makes
     * hooks authoritative for status; until then metadata remains a completion fallback when a
     * later hook is lost, and it always owns identity/title/usage.
     */
    observeLifecycleSignal(signal: AgentLifecycleSignal): boolean {
        if (this.launchIdsByTerminal.get(signal.terminalId) !== signal.launchId) return false;
        const terminal = this.database.getTerminal(signal.terminalId);
        if (!terminal) return false;
        /**
         * Hook environment is inherited by every child of a Shell PTY so an alias-launched Agent
         * can use it later. It is not provider identity: only the independent foreground-process
         * and metadata promotion paths may establish that binding.
         */
        if (terminal.provider !== signal.provider) return false;
        if (signal.phase === 'turnStarted')
            this.hookAuthoritativeLaunchIds.delete(signal.terminalId);
        else this.hookAuthoritativeLaunchIds.set(signal.terminalId, signal.launchId);
        const isUpdated = this.database.updateAgentLifecycle(signal);
        if (isUpdated) this.emitAgentMetadataChange(signal.terminalId);
        return true;
    }

    /**
    Drops hook authority when installation health proves the provider definition is no longer current.
     */
    resetHookAuthority(provider: AgentProvider): void {
        for (const terminal of this.database.listTerminals())
            if (terminal.provider === provider) this.hookAuthoritativeLaunchIds.delete(terminal.id);
    }

    /**
    Starts a fresh correlation window before a new Agent process can see historical metadata.
     */
    prepareTerminalStart(terminalId: string): void {
        const terminal = this.database.getTerminal(terminalId);
        if (!terminal?.provider) return;
        /**
        Invalidate probes started for the previous process before clearing its durable binding.
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
    Starts a new process generation while preserving the Agent session it will resume.
     */
    prepareTerminalResume(terminalId: string): void {
        const terminal = this.database.getTerminal(terminalId);
        if (!terminal?.provider) return;
        this.probeGenerations.set(terminalId, (this.probeGenerations.get(terminalId) ?? 0) + 1);
        this.refreshes.cancel(terminalId);
        this.startedAtByTerminal.set(terminalId, Date.now());
    }

    /**
    Probes now instead of waiting for output, for a Terminal that just started or restarted.
     */
    probeTerminal(terminalId: string): void {
        /**
        `probe` always catches and logs its own errors internally, so this promise never rejects.
        This is a fire-and-forget entry point called from synchronous Runtime dispatch paths that
        cannot become async without changing their own public, sync contracts.
         */
        // eslint-disable-next-line no-void -- see comment above; awaiting is not possible here
        void this.probe(terminalId);
    }

    /**
    Keeps a Session title current when its primary Agent Terminal changed or was promoted.
     */
    probeSessionPrimaryAgent(sessionId: string): void {
        const session = this.database.getSession(sessionId);
        if (session?.primaryAgentTerminalId) this.probeTerminal(session.primaryAgentTerminalId);
    }

    /**
    Drops a pending refresh for a Terminal whose durable record is about to disappear.
     */
    forgetTerminal(terminalId: string): void {
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
    }
}

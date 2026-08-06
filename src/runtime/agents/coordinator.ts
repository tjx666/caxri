import { agentProviderCatalog, agentProviderIds, type AgentProviderId } from '../../shared/agents';
import type { RuntimeEvent } from '../../shared/ipc/events';
import type { StructuredLogger } from '../../shared/node/logger';
import type { AgentProvider, TerminalRecord } from '../../shared/types';
import { CoalescedScheduler } from '../coalesced-scheduler';
import type { CaxriDatabase } from '../db/repository';
import type { AgentService } from './service';

const AGENT_METADATA_REFRESH_DELAY_MS = 2_000;
const MAX_SHELL_COMMAND_LENGTH = 4_096;
const MAX_SHELL_PROMOTION_PROBES = 3;
const SHELL_PROMOTION_WINDOW_MS = 30_000;

interface ShellInputState {
    command: string;
    valid: boolean;
}

interface ShellPromotionCandidate {
    attempts: number;
    expiresAt: number;
    provider: AgentProvider;
    startedAt: number;
}

const providerByExecutableName = new Map<string, AgentProviderId>(
    agentProviderIds.map((provider) => [agentProviderCatalog[provider].executableName, provider]),
);

function directAgentProvider(command: string): AgentProvider | undefined {
    const normalized = command.trim();
    if (/[;&|<>]/.test(normalized)) return undefined;
    const executable = normalized.match(/^(\S+)/)?.[1];
    const basename = executable?.split(/[\\/]/).at(-1);
    return basename ? providerByExecutableName.get(basename) : undefined;
}

export interface AgentCoordinatorOptions {
    /** Trailing delay before Agent Terminal output refreshes durable Agent metadata. */
    refreshDelayMs?: number;
}

/**
 * Single owner of Agent metadata probing. It decides which Terminals are Agent Terminals, schedules
 * the trailing refresh their output implies, and runs the immediate probes that Session and Terminal
 * lifecycle changes require, so no other module needs to track Agent Terminal identity.
 */
export class AgentCoordinator {
    private readonly excludedAgentSessionIdsByTerminal = new Map<string, Set<string>>();
    private readonly refreshes: CoalescedScheduler<string>;
    private readonly shellInputs = new Map<string, ShellInputState>();
    private readonly shellPromotionCandidates = new Map<string, ShellPromotionCandidate>();
    private readonly startedAtByTerminal = new Map<string, number>();

    constructor(
        private readonly database: CaxriDatabase,
        private readonly agents: AgentService,
        private readonly emit: (event: RuntimeEvent) => void,
        private readonly logger: StructuredLogger,
        options: AgentCoordinatorOptions = {},
    ) {
        this.refreshes = new CoalescedScheduler(
            options.refreshDelayMs ?? AGENT_METADATA_REFRESH_DELAY_MS,
            (terminalId: string) => this.probe(terminalId),
        );
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
        const normalized = data.replaceAll('\u001B[200~', '').replaceAll('\u001B[201~', '');
        for (const character of normalized) {
            if (character === '\r' || character === '\n') {
                if (state.valid && state.command.trim()) {
                    const provider = directAgentProvider(state.command);
                    if (provider) {
                        const startedAt = Date.now();
                        this.shellPromotionCandidates.set(terminalId, {
                            attempts: 0,
                            expiresAt: startedAt + SHELL_PROMOTION_WINDOW_MS,
                            provider,
                            startedAt,
                        });
                        this.refreshes.schedule(terminalId);
                    } else {
                        this.shellPromotionCandidates.delete(terminalId);
                    }
                }
                state = { command: '', valid: true };
                continue;
            }
            if (character === '\u0003' || character === '\u0015') {
                state = { command: '', valid: true };
                this.shellPromotionCandidates.delete(terminalId);
                continue;
            }
            if (character === '\b' || character === '\u007F') {
                if (state.valid) state.command = [...state.command].slice(0, -1).join('');
                continue;
            }
            if (character === '\u001B' || character === '\t') {
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
     * Agent membership normally comes from the durable provider. A Shell with a direct-command
     * candidate may enter the same coalesced probe path, but only provider metadata can promote it.
     */
    observeOutput(terminalId: string): void {
        const terminal = this.database.getTerminal(terminalId);
        if (!terminal) return;
        if (!terminal.provider) {
            const candidate = this.shellPromotionCandidates.get(terminalId);
            if (!candidate) return;
            if (candidate.expiresAt < Date.now()) {
                this.shellPromotionCandidates.delete(terminalId);
                return;
            }
        }
        this.refreshes.schedule(terminalId);
    }

    /** Starts a fresh correlation window before a new Agent process can see historical metadata. */
    prepareTerminalStart(terminalId: string): void {
        const terminal = this.database.getTerminal(terminalId);
        if (!terminal?.provider) return;
        this.shellInputs.delete(terminalId);
        this.shellPromotionCandidates.delete(terminalId);
        const startedAt = Date.now();
        const excluded = new Set(this.excludedAgentSessionIdsByTerminal.get(terminalId));
        if (terminal.agentSessionId) excluded.add(terminal.agentSessionId);
        this.excludedAgentSessionIdsByTerminal.set(terminalId, excluded);
        this.startedAtByTerminal.set(terminalId, startedAt);
        this.database.resetAgentMetadataForStart(terminalId, startedAt);
    }

    /** Probes now instead of waiting for output, for a Terminal that just started or restarted. */
    probeTerminal(terminalId: string): void {
        void this.probe(terminalId);
    }

    /** Keeps a Session title current when its primary Agent Terminal changed or was promoted. */
    probeSessionPrimaryAgent(sessionId: string): void {
        const session = this.database.getSession(sessionId);
        if (session?.primaryAgentTerminalId) this.probeTerminal(session.primaryAgentTerminalId);
    }

    /** Drops a pending refresh for a Terminal whose durable record is about to disappear. */
    forgetTerminal(terminalId: string): void {
        this.refreshes.cancel(terminalId);
        this.excludedAgentSessionIdsByTerminal.delete(terminalId);
        this.shellInputs.delete(terminalId);
        this.shellPromotionCandidates.delete(terminalId);
        this.startedAtByTerminal.delete(terminalId);
    }

    forgetSession(sessionId: string): void {
        for (const terminal of this.database.listTerminals(sessionId)) {
            this.refreshes.cancel(terminal.id);
            this.excludedAgentSessionIdsByTerminal.delete(terminal.id);
            this.shellInputs.delete(terminal.id);
            this.shellPromotionCandidates.delete(terminal.id);
            this.startedAtByTerminal.delete(terminal.id);
        }
    }

    close(): void {
        this.refreshes.close();
        this.shellInputs.clear();
        this.shellPromotionCandidates.clear();
    }

    private async probe(terminalId: string, retryClaim = true): Promise<void> {
        try {
            const terminal = this.database.getTerminal(terminalId);
            if (!terminal) return;
            if (!terminal.provider) {
                await this.probeShellPromotion(terminal, retryClaim);
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
                rootPath: session.rootPath,
                processState: terminal.lastProcessState,
                startedAt: this.startedAtByTerminal.get(terminal.id) ?? terminal.createdAt,
            });
            if (
                snapshot.sessionId &&
                this.database.isAgentSessionClaimedByOtherTerminal(terminal.id, snapshot.sessionId)
            ) {
                if (retryClaim) await this.probe(terminalId, false);
                return;
            }
            if (this.database.updateAgentMetadata(terminal.id, snapshot))
                this.emit({ event: 'state.changed', payload: { reason: 'agent.metadata' } });
        } catch (error) {
            /** A failed probe degrades Agent metadata to unknown; it never interrupts the Runtime. */
            this.logger.write('warn', 'agent.probe_failed', {
                fields: {
                    terminalId,
                    error: error instanceof Error ? error.message : 'unknown',
                },
            });
        }
    }

    private async probeShellPromotion(
        terminal: TerminalRecord,
        retryClaim: boolean,
    ): Promise<void> {
        const candidate = this.shellPromotionCandidates.get(terminal.id);
        if (!candidate || terminal.kind !== 'shell') return;
        if (candidate.expiresAt < Date.now()) {
            this.shellPromotionCandidates.delete(terminal.id);
            return;
        }
        const session = this.database.getSession(terminal.sessionId);
        if (!session) return;
        candidate.attempts += 1;
        const snapshot = await this.agents.snapshot(candidate.provider, {
            correlationId: `${terminal.id}:shell-promotion:${candidate.startedAt}`,
            excludedAgentSessionIds: this.database.claimedAgentSessionIdsForProvider(
                candidate.provider,
                terminal.id,
            ),
            rootPath: session.rootPath,
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
        if (!this.database.promoteShellToAgent(terminal.id, snapshot)) {
            if (retryClaim) await this.probe(terminal.id, false);
            return;
        }
        this.shellInputs.delete(terminal.id);
        this.shellPromotionCandidates.delete(terminal.id);
        this.startedAtByTerminal.set(terminal.id, candidate.startedAt);
        this.emit({ event: 'state.changed', payload: { reason: 'agent.metadata' } });
    }
}

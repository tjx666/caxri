import type { TerminalRecord } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import type { AgentProbeSnapshot } from './contract';
import { agentProviderStateRoot } from './contract';
import type { AgentLifecycleSignal } from './hooks/contract';
import type { AgentService } from './service';

const MAX_CONFIRMATION_PROBES = 3;

interface RebindCandidate {
    agentSessionId: string;
    attempts: number;
    launchId: string;
}

/**
 * Fences a different Codex thread identity behind both its main `SessionStart` hook and an exact persisted metadata
 * read. Codex can run root-like background threads inside the same process tree; their authenticated hooks prove the
 * Terminal generation, but not that the background thread replaced the foreground conversation.
 */
export class CodexHookSessionRebindTracker {
    private readonly candidates = new Map<string, RebindCandidate>();

    constructor(
        private readonly database: CaxriDatabase,
        private readonly agents: AgentService,
        private readonly currentLaunchId: (terminalId: string) => string | undefined,
        private readonly currentProcessId: (terminalId: string) => number | undefined,
        private readonly scheduleProbe: (terminalId: string) => void,
    ) {}

    private retryOrForget(terminalId: string, candidate: RebindCandidate): void {
        if (this.candidates.get(terminalId) !== candidate) return;
        if (candidate.attempts >= MAX_CONFIRMATION_PROBES) this.candidates.delete(terminalId);
        else this.scheduleProbe(terminalId);
    }

    /**
     * Returns true when the coordinator must not apply the different identity synchronously.
     */
    defer(signal: AgentLifecycleSignal, terminal: TerminalRecord): boolean {
        if (
            signal.provider !== 'codex' ||
            !terminal.agentSessionId ||
            !signal.agentSessionId ||
            signal.agentSessionId === terminal.agentSessionId
        ) {
            if (
                signal.provider === 'codex' &&
                signal.phase === 'sessionIdentified' &&
                !signal.agentId &&
                signal.agentSessionId === terminal.agentSessionId
            )
                this.candidates.delete(terminal.id);
            return false;
        }

        if (signal.phase === 'sessionIdentified' && !signal.agentId) {
            const candidate = this.candidates.get(terminal.id);
            if (
                candidate?.launchId !== signal.launchId ||
                candidate.agentSessionId !== signal.agentSessionId
            ) {
                this.candidates.set(terminal.id, {
                    agentSessionId: signal.agentSessionId,
                    attempts: 0,
                    launchId: signal.launchId,
                });
            }
            this.scheduleProbe(terminal.id);
        }
        return true;
    }

    async probe(terminal: TerminalRecord, startedAt: number): Promise<boolean> {
        const candidate = this.candidates.get(terminal.id);
        if (!candidate) return false;
        if (
            terminal.provider !== 'codex' ||
            this.currentLaunchId(terminal.id) !== candidate.launchId
        ) {
            this.candidates.delete(terminal.id);
            return false;
        }

        candidate.attempts += 1;
        const correlationId = `${terminal.id}:hook-session-rebind:${candidate.attempts}`;
        let snapshot: AgentProbeSnapshot;
        try {
            snapshot = await this.agents.snapshot('codex', {
                agentSessionId: candidate.agentSessionId,
                correlationId,
                excludedAgentSessionIds: [],
                processState: terminal.lastProcessState,
                rootPath: agentProviderStateRoot(terminal),
                startedAt,
            });
        } catch (error) {
            this.retryOrForget(terminal.id, candidate);
            throw error;
        }
        const current = this.candidates.get(terminal.id);
        const currentTerminal = this.database.getTerminal(terminal.id);
        if (
            current !== candidate ||
            this.currentLaunchId(terminal.id) !== candidate.launchId ||
            currentTerminal?.provider !== 'codex' ||
            currentTerminal.agentSessionId !== terminal.agentSessionId
        ) {
            if (current === candidate) this.candidates.delete(terminal.id);
            return false;
        }

        if (snapshot.sessionId !== candidate.agentSessionId) {
            this.retryOrForget(terminal.id, candidate);
            return false;
        }
        if (snapshot.sessionIsSubagent) {
            this.candidates.delete(terminal.id);
            return false;
        }

        const shellPid = this.currentProcessId(terminal.id);
        let isForeground = false;
        if (shellPid !== undefined) {
            try {
                const foreground = await this.agents.snapshot('codex', {
                    correlationId: `${correlationId}:foreground`,
                    excludedAgentSessionIds: [
                        ...(terminal.agentSessionId ? [terminal.agentSessionId] : []),
                        ...this.database.claimedAgentSessionIds(terminal.id),
                    ],
                    processState: terminal.lastProcessState,
                    requireForegroundProcessIdentity: true,
                    rootPath: agentProviderStateRoot(terminal),
                    shellPid,
                    startedAt,
                });
                isForeground = foreground.sessionId === candidate.agentSessionId;
            } catch (error) {
                this.retryOrForget(terminal.id, candidate);
                throw error;
            }
        }
        if (!isForeground) {
            this.retryOrForget(terminal.id, candidate);
            return false;
        }
        const confirmedCurrent = this.candidates.get(terminal.id);
        const confirmedTerminal = this.database.getTerminal(terminal.id);
        if (
            confirmedCurrent !== candidate ||
            this.currentLaunchId(terminal.id) !== candidate.launchId ||
            confirmedTerminal?.provider !== 'codex' ||
            confirmedTerminal.agentSessionId !== terminal.agentSessionId
        ) {
            if (confirmedCurrent === candidate) this.candidates.delete(terminal.id);
            return false;
        }

        try {
            const rebound = this.database.rebindAgentSession(
                terminal.id,
                'codex',
                candidate.agentSessionId,
            );
            if (rebound) this.candidates.delete(terminal.id);
            else this.retryOrForget(terminal.id, candidate);
            return rebound;
        } catch (error) {
            this.retryOrForget(terminal.id, candidate);
            throw error;
        }
    }

    forget(terminalId: string): void {
        this.candidates.delete(terminalId);
    }

    clear(): void {
        this.candidates.clear();
    }
}

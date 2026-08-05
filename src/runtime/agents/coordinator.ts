import type { RuntimeEvent } from '../../shared/ipc';
import type { StructuredLogger } from '../../shared/node/logger';
import { CoalescedScheduler } from '../coalesced-scheduler';
import type { CaxriDatabase } from '../database';
import type { AgentService } from './service';

const AGENT_METADATA_REFRESH_DELAY_MS = 2_000;

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
    private readonly refreshes: CoalescedScheduler<string>;

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
     * Agent Terminal membership is derived from the durable Terminal record instead of a cached Set
     * that every create/close/delete path would have to update. The read is one primary-key SQLite
     * lookup on an already coalesced path: PTY output is batched before it becomes an event, so this
     * runs at most once per output batch per Terminal and cannot drift from database truth.
     */
    observeOutput(terminalId: string): void {
        if (!this.database.getTerminal(terminalId)?.provider) return;
        this.refreshes.schedule(terminalId);
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
    }

    forgetSession(sessionId: string): void {
        for (const terminal of this.database.listTerminals(sessionId))
            this.refreshes.cancel(terminal.id);
    }

    close(): void {
        this.refreshes.close();
    }

    private async probe(terminalId: string): Promise<void> {
        try {
            const terminal = this.database.getTerminal(terminalId);
            if (!terminal?.provider) return;
            const session = this.database.getSession(terminal.sessionId);
            if (!session) return;
            const snapshot = await this.agents.snapshot(terminal.provider, {
                agentSessionId: terminal.agentSessionId,
                rootPath: session.rootPath,
                processState: terminal.lastProcessState,
            });
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
}

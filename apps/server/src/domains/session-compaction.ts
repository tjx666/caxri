import type {
    SessionCompactionOutcome,
    SessionCompactionResult,
    TerminalRecord,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import {
    assertE2EAgentInputFromEnvironment,
    logEventCatalog,
    mapWithConcurrency,
} from '@caxri/system';

import type { AgentCoordinator, AgentEnvironment, CompactionReadiness } from './agents';
import { inspectContextCache, readAgentTranscript } from './agents';
import type { CaxriDatabase } from './db';
import type { TerminalManager } from './terminal';

interface Options {
    database: CaxriDatabase;
    logger?: StructuredLogger;
    coordinator: Pick<AgentCoordinator, 'agentOperation' | 'hasIdleProof' | 'observeInput'>;
    terminals: Pick<TerminalManager, 'agentLaunchId' | 'agentProcessId' | 'writeAgentExact'>;
    readiness: CompactionReadiness;
    environment: AgentEnvironment;
    now?: () => number;
    readTranscript?: typeof readAgentTranscript;
}
interface Target {
    terminal: TerminalRecord;
    launchId: string;
    turnId: string;
}

/**
 * One owner request operates only on visible, live primary Agents. Transcript contents remain in Server memory; replies
 * contain opaque Session IDs and closed outcomes. Repeated invocations coalesce while scanning.
 */
export class SessionCompaction {
    private running?: Promise<SessionCompactionResult>;

    constructor(private readonly options: Options) {}

    private target(sessionId: string): Target | SessionCompactionOutcome {
        const { database, terminals, coordinator, readiness } = this.options;
        const session = database.getSession(sessionId);
        if (
            !session ||
            session.archivedAt !== undefined ||
            database.getProject(session.projectId)?.hiddenAt !== undefined
        )
            return 'changed';
        const terminal =
            session.primaryAgentTerminalId && database.getTerminal(session.primaryAgentTerminalId);
        if (!terminal || (terminal.provider !== 'claude' && terminal.provider !== 'codex'))
            return 'unsupported';
        const launchId = terminals.agentLaunchId(terminal.id);
        if (
            !launchId ||
            terminals.agentProcessId(terminal.id) === undefined ||
            !terminal.agentSessionId
        )
            return 'not_running';
        if (
            coordinator.agentOperation(terminal.id) ||
            !['idle', 'completed'].includes(session.lastActivityState)
        )
            return 'busy';
        const proof = readiness.proof(terminal.id);
        if (
            !proof ||
            proof.launchId !== launchId ||
            !coordinator.hasIdleProof(terminal.id, launchId, proof.turnId)
        )
            return 'unsafe_input';
        return { terminal, launchId, turnId: proof.turnId };
    }

    private async compact(
        sessionId: string,
        signal?: AbortSignal,
    ): Promise<SessionCompactionOutcome> {
        const target = this.target(sessionId);
        if (typeof target === 'string') return target;
        const transcript = await (this.options.readTranscript ?? readAgentTranscript)(
            this.options.database,
            target.terminal.id,
            true,
            this.options.environment,
        );
        signal?.throwIfAborted();
        const observation = inspectContextCache(
            target.terminal.provider!,
            transcript?.content ?? '',
        );
        if (observation.status !== 'measured') return observation.status;
        const { activityAt, ttlMinutes } = observation.usage;
        const age = (this.options.now?.() ?? Date.now()) - activityAt;
        if (age < 0 || age >= ttlMinutes * 60_000) return 'cache_expired';
        const current = this.target(sessionId);
        if (
            typeof current === 'string' ||
            current.terminal.id !== target.terminal.id ||
            current.terminal.agentSessionId !== target.terminal.agentSessionId ||
            current.terminal.provider !== target.terminal.provider ||
            current.launchId !== target.launchId ||
            current.turnId !== target.turnId
        )
            return 'changed';
        assertE2EAgentInputFromEnvironment(target.terminal.provider);
        /**
         * Consume before sending: even an ambiguous delivery must never be automatically retried.
         */
        this.options.readiness.forget(target.terminal.id);
        return this.deliver(target);
    }

    private deliver(target: Target): Promise<SessionCompactionOutcome> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve('delivery_unknown'), 2_000);
            const settle = (outcome: SessionCompactionOutcome): void => {
                clearTimeout(timer);
                resolve(outcome);
            };
            try {
                const accepted = this.options.terminals.writeAgentExact(
                    target.terminal.id,
                    '/compact\r',
                    target.launchId,
                    'human',
                    (delivered) => settle(delivered ? 'submitted' : 'failed'),
                );
                if (!accepted) settle('failed');
                else {
                    this.options.coordinator.observeInput(target.terminal.id, '/compact\r');
                }
            } catch {
                settle('delivery_unknown');
            }
        });
    }

    private async compactItem(
        sessionId: string,
        signal?: AbortSignal,
    ): Promise<SessionCompactionResult['items'][number]> {
        signal?.throwIfAborted();
        const startedAt = Date.now();
        let outcome: SessionCompactionOutcome;
        try {
            outcome = await this.compact(sessionId, signal);
        } catch {
            signal?.throwIfAborted();
            outcome = 'failed';
        }
        this.options.logger?.write('info', logEventCatalog.sessionCompaction.checked, {
            fields: { sessionId, reason: outcome, durationMs: Date.now() - startedAt },
        });
        return { sessionId, outcome };
    }

    private async runBatch(signal?: AbortSignal): Promise<SessionCompactionResult> {
        const sessions = this.options.database
            .listVisibleSessions()
            .filter((session) => session.archivedAt === undefined);
        /**
         * One scan at a time bounds transcript memory; every target rechecks freshness at delivery.
         */
        const items = await mapWithConcurrency(sessions.slice(0, 200), 1, (session) =>
            this.compactItem(session.id, signal),
        );
        return { items, deferred: Math.max(0, sessions.length - 200) };
    }

    async run(signal?: AbortSignal): Promise<SessionCompactionResult> {
        if (this.running) return this.running;
        this.running = this.runBatch(signal);
        try {
            return await this.running;
        } finally {
            this.running = undefined;
        }
    }
}

import type {
    SessionCompactionOutcome,
    SessionCompactionResult,
    SessionRecord,
    TerminalRecord,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import {
    assertE2EAgentInputFromEnvironment,
    logEventCatalog,
    mapWithConcurrency,
} from '@caxri/system';

import type { AgentChatService } from '../agent-chat';
import type { AgentCoordinator, AgentEnvironment, CompactionReadiness } from '../agents';
import { inspectContextCache, readAgentTranscript } from '../agents';
import type { CaxriDatabase } from '../db';
import { isPtyTerminal } from '../pty-guard';
import type { TerminalManager } from '../terminal';

interface Options {
    agentChat: Pick<AgentChatService, 'compactIdle' | 'idleLaunchId' | 'isLive'>;
    database: CaxriDatabase;
    logger?: StructuredLogger;
    coordinator: Pick<
        AgentCoordinator,
        'agentOperation' | 'beginMaintenanceInput' | 'hasIdleProof' | 'observeInput'
    >;
    terminals: Pick<TerminalManager, 'agentLaunchId' | 'agentProcessId' | 'writeAgentExact'>;
    readiness: CompactionReadiness;
    environment: AgentEnvironment;
    now?: () => number;
    readTranscript?: typeof readAgentTranscript;
}
interface Target {
    /**
     * An Agent Chat compacts through its provider protocol instead of typing `/compact` into a PTY.
     */
    isChat: boolean;
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
        if (!isPtyTerminal(terminal)) return this.chatTarget(terminal, session.lastActivityState);
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
        return { isChat: false, terminal, launchId, turnId: proof.turnId };
    }

    /**
     * A Chat's own projection proves it idle, so it needs no PTY input proof. A stopped Chat is never woken: starting a
     * provider only to compact it would cost more than the cache it saves.
     */
    private chatTarget(
        terminal: TerminalRecord,
        activity: SessionRecord['lastActivityState'],
    ): Target | SessionCompactionOutcome {
        if (
            !terminal.agentSessionId ||
            terminal.lastProcessState !== 'running' ||
            !this.options.agentChat.isLive(terminal.id)
        )
            return 'not_running';
        const launchId = this.options.agentChat.idleLaunchId(terminal.id);
        if (!launchId || !['idle', 'completed'].includes(activity)) return 'busy';
        return { isChat: true, terminal, launchId, turnId: launchId };
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
        if (target.isChat) return this.deliverToChat(target);
        assertE2EAgentInputFromEnvironment(target.terminal.provider);
        /**
         * Consume before sending: even an ambiguous delivery must never be automatically retried.
         */
        this.options.readiness.forget(target.terminal.id);
        return this.deliver(target);
    }

    private async deliverToChat(target: Target): Promise<SessionCompactionOutcome> {
        try {
            await this.options.agentChat.compactIdle(target.terminal.id, target.launchId);
            return 'submitted';
        } catch (error) {
            // `compactIdle` refuses a Chat that left its idle launch, or a provider without a native compact command.
            if (error instanceof CaxriError && error.code === 'CONFLICT') return 'changed';
            if (error instanceof CaxriError && error.code === 'VALIDATION') return 'unsupported';
            return 'failed';
        }
    }

    private deliver(target: Target): Promise<SessionCompactionOutcome> {
        const lease = this.options.coordinator.beginMaintenanceInput(
            target.terminal.id,
            target.launchId,
        );
        if (!lease) return Promise.resolve('changed');
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
                    'maintenance',
                    (delivered) => {
                        if (!delivered) lease.cancel();
                        settle(delivered ? 'submitted' : 'failed');
                    },
                );
                if (!accepted) {
                    lease.cancel();
                    settle('failed');
                } else {
                    this.options.coordinator.observeInput(
                        target.terminal.id,
                        '/compact\r',
                        'maintenance',
                    );
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

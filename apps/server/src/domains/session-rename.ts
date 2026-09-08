import type { AgentProvider, ServerEvent, SessionRecord } from '@caxri/protocol';
import { CaxriError, sessionRenameTitleSchema } from '@caxri/protocol';

import type { AgentCoordinator, AgentService } from './agents';
import type { CaxriDatabase } from './db';

const MAXIMUM_AGENT_TARGET_CHANGES = 3;

interface AgentRenameTarget {
    agentSessionId: string;
    cwd: string;
    provider: AgentProvider;
    terminalId: string;
}

/**
 * Serializes the complete native-provider plus SQLite rename sequence per Session. Without this queue, a slower earlier
 * provider request could overwrite a newer name after the newer request had already completed.
 */
export class SessionRenameQueue {
    private readonly tails = new Map<string, Promise<void>>();

    run<Result>(sessionId: string, rename: () => Promise<Result>): Promise<Result> {
        const previous = this.tails.get(sessionId) ?? Promise.resolve();
        // eslint-disable-next-line unicorn/prefer-await -- the next tail must be installed before another call enters
        const result = previous.then(rename);
        // eslint-disable-next-line unicorn/prefer-await -- the tail intentionally converts success/failure to completion
        const tail = result.then(() => {}).catch(() => {});
        this.tails.set(sessionId, tail);
        // eslint-disable-next-line no-void -- cleanup observes an already non-rejecting completion tail
        void tail.finally(() => {
            if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
        });
        return result;
    }
}

/**
 * Owns manual Session rename from exact primary-Agent identity resolution through provider synchronization and the
 * durable Caxri title update.
 */
export class SessionRenameService {
    private static isSameTarget(first: AgentRenameTarget, second: AgentRenameTarget): boolean {
        return (
            first.terminalId === second.terminalId &&
            first.provider === second.provider &&
            first.agentSessionId === second.agentSessionId &&
            first.cwd === second.cwd
        );
    }

    constructor(
        private readonly database: CaxriDatabase,
        private readonly agents: AgentService,
        private readonly coordinator: AgentCoordinator,
        private readonly emit: (event: ServerEvent) => void,
        private readonly queue = new SessionRenameQueue(),
    ) {}

    private async primaryAgentTarget(sessionId: string): Promise<AgentRenameTarget | undefined> {
        const session = this.database.getSession(sessionId);
        if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
        if (!session.primaryAgentTerminalId) return undefined;
        let terminal = this.database.getTerminal(session.primaryAgentTerminalId);
        if (!terminal) throw new CaxriError('INTERNAL', 'Primary Agent Terminal is missing');
        if (!terminal.provider)
            throw new CaxriError('INTERNAL', 'Primary Agent Terminal has no provider');
        if (!terminal.agentSessionId) {
            await this.coordinator.probeTerminalNow(terminal.id);
            const currentSession = this.database.getSession(sessionId);
            if (!currentSession) throw new CaxriError('NOT_FOUND', 'Session not found');
            if (!currentSession.primaryAgentTerminalId) return undefined;
            terminal = this.database.getTerminal(currentSession.primaryAgentTerminalId);
        }
        if (!terminal?.agentSessionId)
            throw new CaxriError(
                'UNAVAILABLE',
                'The primary Agent session has not been identified yet',
            );
        if (!terminal.provider)
            throw new CaxriError('INTERNAL', 'Primary Agent Terminal has no provider');
        return {
            agentSessionId: terminal.agentSessionId,
            cwd: terminal.cwd,
            provider: terminal.provider,
            terminalId: terminal.id,
        };
    }

    private async apply(
        sessionId: string,
        displayTitle: string,
        signal?: AbortSignal,
        finalizeDurably?: <Result>(commit: () => Result) => Result,
    ): Promise<SessionRecord> {
        if (signal?.aborted)
            throw new CaxriError('CANCELLED', 'Session rename was cancelled before it started');
        let appliedTitle = displayTitle;
        const renamedTerminalIds = new Set<string>();
        let target = await this.primaryAgentTarget(sessionId);
        for (let attempt = 0; target; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop -- changed targets must be renamed in observed order
            const renamed = await this.agents.renameSession(target.provider, {
                agentSessionId: target.agentSessionId,
                cwd: target.cwd,
                displayTitle,
                signal,
            });
            appliedTitle = renamed.displayTitle;
            renamedTerminalIds.add(target.terminalId);
            // eslint-disable-next-line no-await-in-loop -- each result must be checked against current Agent identity
            const currentTarget = await this.primaryAgentTarget(sessionId);
            if (!currentTarget || SessionRenameService.isSameTarget(target, currentTarget)) break;
            if (attempt + 1 >= MAXIMUM_AGENT_TARGET_CHANGES)
                throw new CaxriError(
                    'CONFLICT',
                    'The primary Agent changed repeatedly during Session rename',
                );
            target = currentTarget;
        }
        const commit = (): SessionRecord => {
            const renamed = this.database.renameSession(sessionId, appliedTitle);
            this.emit({
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [sessionId], terminalIds: [] },
            });
            return renamed;
        };
        const renamed = finalizeDurably ? finalizeDurably(commit) : commit();
        for (const terminalId of renamedTerminalIds) this.coordinator.probeTerminal(terminalId);
        return renamed;
    }

    rename(
        sessionId: string,
        displayTitle: string,
        signal?: AbortSignal,
        finalizeDurably?: <Result>(commit: () => Result) => Result,
    ): Promise<SessionRecord> {
        const parsedTitle = sessionRenameTitleSchema.safeParse(displayTitle);
        if (!parsedTitle.success)
            return Promise.reject(
                new CaxriError(
                    'VALIDATION',
                    parsedTitle.error.issues[0]?.message ?? 'Session name is invalid',
                ),
            );
        const normalizedTitle = parsedTitle.data;
        return this.queue.run(sessionId, () =>
            this.apply(sessionId, normalizedTitle, signal, finalizeDurably),
        );
    }
}

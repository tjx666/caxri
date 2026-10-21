import type {
    AgentProvider,
    SessionAgentHistoryEntry,
    SessionAgentHistoryResult,
    TerminalRecord,
} from '@caxri/protocol';
import { CaxriError, MAX_SESSION_AGENT_HISTORY_ENTRIES } from '@caxri/protocol';

import type { SessionSearchIndex } from '../agents';
import type { CaxriDatabase } from '../db';
import { isDirectory } from './search';

function conversationKey(provider: AgentProvider, agentSessionId: string): string {
    return `${provider}:${agentSessionId}`;
}

/**
 * The Terminal anywhere in Caxri currently bound to each conversation.
 */
function boundTerminals(terminals: readonly TerminalRecord[]): Map<string, TerminalRecord> {
    const bound = new Map<string, TerminalRecord>();
    for (const terminal of terminals)
        if (terminal.provider && terminal.agentSessionId)
            bound.set(conversationKey(terminal.provider, terminal.agentSessionId), terminal);
    return bound;
}

/**
 * The Agent conversations a Session has hosted, and bringing one back after its Terminal was closed or reused. The
 * usage ledger is the only durable record of them: `terminals.agent_session_id` holds only the current binding and is
 * overwritten by `/clear`, provider switches, and Terminal close.
 */
export class SessionAgentHistoryService {
    constructor(
        private readonly options: {
            database: CaxriDatabase;
            index: Pick<SessionSearchIndex, 'describe'>;
            onTerminalCreated: () => void;
        },
    ) {}

    /**
     * Newest binding first. A conversation since resumed in another Session belongs to that Session now and is left
     * out, so the card never offers to open one conversation in two Terminals.
     */
    async list(sessionId: string, signal?: AbortSignal): Promise<SessionAgentHistoryResult> {
        const { database } = this.options;
        if (!database.getSession(sessionId)) throw new CaxriError('NOT_FOUND', 'Session not found');
        const bound = boundTerminals(database.listTerminals());
        const entries = new Map<string, SessionAgentHistoryEntry>();
        for (const row of database.agentSessionUsage.listForSession(sessionId)) {
            const terminal = bound.get(conversationKey(row.provider, row.agentSessionId));
            if (terminal && terminal.sessionId !== sessionId) continue;
            entries.set(conversationKey(row.provider, row.agentSessionId), {
                provider: row.provider,
                agentSessionId: row.agentSessionId,
                boundAt: row.boundAt,
                ...(terminal && { terminalId: terminal.id }),
            });
        }
        // A binding the ledger has not recorded yet (or that another Session paid for first) is still this Session's.
        for (const terminal of database.listTerminals(sessionId)) {
            if (!terminal.provider || !terminal.agentSessionId) continue;
            const key = conversationKey(terminal.provider, terminal.agentSessionId);
            if (entries.has(key)) continue;
            entries.set(key, {
                provider: terminal.provider,
                agentSessionId: terminal.agentSessionId,
                boundAt: terminal.createdAt,
                terminalId: terminal.id,
            });
        }
        const listed = entries
            .values()
            .toArray()
            .toSorted((left, right) => right.boundAt - left.boundAt)
            .slice(0, MAX_SESSION_AGENT_HISTORY_ENTRIES);
        let titles: Array<string | undefined> = [];
        try {
            titles = await this.options.index.describe(
                listed.map(({ provider, agentSessionId }) => ({ provider, agentSessionId })),
                signal,
            );
        } catch (error) {
            if (signal?.aborted) throw error;
            // Without the index the card still lists every conversation, labeled by Agent and time.
        }
        return {
            entries: listed.map((entry, index) => {
                const title = titles[index]?.trim().slice(0, 1_024);
                return title ? { ...entry, title } : entry;
            }),
        };
    }

    /**
     * Returns the Session's Terminal holding the conversation, creating a parked Agent Terminal bound to it in the
     * ledger's recorded folder when none does. The new Terminal is placed as a background tab of every arranged Root,
     * and revealing it resumes the conversation, as an imported conversation's Terminal does.
     */
    async reopen(
        sessionId: string,
        provider: AgentProvider,
        agentSessionId: string,
    ): Promise<{ terminalId: string }> {
        const { database } = this.options;
        const session = database.getSession(sessionId);
        if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
        if (session.archivedAt !== undefined)
            throw new CaxriError(
                'CONFLICT',
                'Restore this Session before reopening its conversations',
            );
        const key = conversationKey(provider, agentSessionId);
        const terminal = boundTerminals(database.listTerminals()).get(key);
        if (terminal) {
            if (terminal.sessionId === sessionId) return { terminalId: terminal.id };
            throw new CaxriError('CONFLICT', 'Another Session has this conversation open');
        }
        const row = database.agentSessionUsage
            .listForSession(sessionId)
            .find(
                (candidate) =>
                    candidate.provider === provider && candidate.agentSessionId === agentSessionId,
            );
        if (!row) throw new CaxriError('NOT_FOUND', 'This Session never hosted that conversation');
        if (!(await isDirectory(row.cwd)))
            throw new CaxriError(
                'NOT_FOUND',
                'The folder this conversation ran in no longer exists',
            );
        const created = database.createTerminal(sessionId, provider, row.cwd);
        database.rebindAgentSession(created.id, provider, agentSessionId);
        database.updateTerminalState(created.id, 'detached');
        database.updateAgentProcessState(created.id, 'detached');
        this.options.onTerminalCreated();
        return { terminalId: created.id };
    }
}

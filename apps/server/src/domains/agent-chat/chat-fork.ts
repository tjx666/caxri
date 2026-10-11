import type { AgentChatRewindRefusal, AgentProvider } from '@caxri/protocol';
import { agentChatRewindTarget, CaxriError } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import { requireChatTerminal } from './chat-launch';
import type { ChatStateDelivery } from './chat-states';
import type { AgentChatServiceOptions } from './service-options';

const FORK_REFUSALS: Record<AgentChatRewindRefusal, string> = {
    turnRunning: 'Stop the running turn before forking the conversation',
    notTurnStart:
        'This message joined a turn that was already running, so the conversation cannot fork from it',
    unknownMessage: 'This message is no longer in the conversation',
};

/**
 * The source Chat declined the fork before anything changed, as opposed to a provider or Session failure.
 */
class ForkRefusal extends CaxriError {}

/**
 * The Chat a fork opens: a new Session of the source's Project whose Chat Terminal runs the same provider in the same
 * cwd, bound to `agentSessionId` before it starts so the start resumes the forked record. Without an id the new Chat
 * starts a conversation of its own. The new Chat Terminal inherits the stored permission level and plan mode of
 * `sourceTerminalId`; a source without a stored choice leaves the new Chat on the Project default.
 */
interface ChatForkSession {
    projectId: string;
    provider: AgentProvider;
    cwd: string;
    agentSessionId: string | undefined;
    sourceTerminalId: string;
}

export type CreateForkSession = (
    fork: ChatForkSession,
) => Promise<{ sessionId: string; terminalId: string }>;

interface ChatForkHost {
    options: AgentChatServiceOptions;
    enqueue: (terminalId: string, deliver: ChatStateDelivery) => Promise<void>;
}

/**
 * "Fork from here": the provider copies its record up to just before user message `itemId` into a new Agent Session (in
 * the source Chat's send chain, so no turn starts meanwhile), then a new Session opens it as a Chat. The source Chat
 * keeps running unchanged. Logs `agent_chat.forked` with a closed outcome and the malformed record lines the provider
 * skipped.
 */
export async function forkChat(
    host: ChatForkHost,
    terminalId: string,
    itemId: string,
    createSession: CreateForkSession,
): Promise<{ sessionId: string; terminalId: string }> {
    const { database, logger } = host.options;
    const terminal = requireChatTerminal(database, terminalId);
    const { provider } = terminal;
    const startedAt = Date.now();
    let keptTurns: number | undefined;
    let skippedRecords: number | undefined;
    const log = (outcome: 'failed' | 'forked' | 'refused', code: string | null = null): void =>
        logger.write('info', logEventCatalog.agentChat.forked, {
            fields: {
                terminalId,
                provider,
                outcome,
                code,
                keptTurns: keptTurns ?? null,
                skippedRecords: skippedRecords ?? null,
                durationMs: Date.now() - startedAt,
            },
        });
    try {
        const projectId = database.getSession(terminal.sessionId)?.projectId;
        if (!projectId) throw new CaxriError('NOT_FOUND', 'Session not found');
        let agentSessionId: string | undefined;
        await host.enqueue(terminalId, async (session, state) => {
            const { snapshot } = state.projection;
            const result = agentChatRewindTarget(snapshot, itemId);
            if ('refusal' in result)
                throw new ForkRefusal('CONFLICT', FORK_REFUSALS[result.refusal]);
            const item = snapshot.items.find((candidate) => candidate.id === itemId);
            keptTurns = result.target.keptTurns;
            /**
             * Nothing comes before the message, so the new Chat starts a conversation of its own: a provider record
             * without a turn may not be resumable (Codex writes no rollout until the first turn).
             */
            if (keptTurns === 0 && !snapshot.truncated) return;
            const fork = await session.fork({
                ...result.target,
                text: item?.type === 'userMessage' ? item.text : '',
            });
            agentSessionId = fork.agentSessionId;
            skippedRecords = fork.skippedRecords;
        });
        const created = await createSession({
            projectId,
            provider,
            cwd: terminal.cwd,
            agentSessionId,
            sourceTerminalId: terminalId,
        });
        log('forked');
        return created;
    } catch (error) {
        log(
            error instanceof ForkRefusal ? 'refused' : 'failed',
            error instanceof CaxriError ? error.code : null,
        );
        throw error;
    }
}

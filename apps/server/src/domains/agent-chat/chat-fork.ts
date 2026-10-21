import type { AgentChatRewindRefusal, AgentChatSnapshot, AgentProvider } from '@caxri/protocol';
import { agentChatRewindTarget, CaxriError } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import { requireChatTerminal } from './chat-launch';
import type { ChatForkTarget } from './chat-provider';
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
 * Where a fork cuts the Chat's projection: just before user message `itemId`, or with no target (the whole
 * conversation) when `itemId` is absent. Throws {@link ForkRefusal} for a running turn, a message the rewind rule
 * refuses, or a whole-conversation fork of a Chat without a turn, which would open an empty Chat that looks like a
 * copy.
 */
function forkCut(
    snapshot: AgentChatSnapshot,
    itemId: string | undefined,
): { keptTurns: number; target: ChatForkTarget | undefined } {
    if (itemId === undefined) {
        // A compaction rewrites the provider's record too, so it counts as a running turn.
        if (snapshot.activeTurnId || snapshot.operation === 'compacting')
            throw new ForkRefusal('CONFLICT', FORK_REFUSALS.turnRunning);
        if (snapshot.turns.length === 0 && !snapshot.truncated)
            throw new ForkRefusal('CONFLICT', 'This conversation has nothing to fork yet');
        return { keptTurns: snapshot.turns.length, target: undefined };
    }
    const result = agentChatRewindTarget(snapshot, itemId);
    if ('refusal' in result) throw new ForkRefusal('CONFLICT', FORK_REFUSALS[result.refusal]);
    const item = snapshot.items.find((candidate) => candidate.id === itemId);
    return {
        keptTurns: result.target.keptTurns,
        target: { ...result.target, text: item?.type === 'userMessage' ? item.text : '' },
    };
}

/**
 * "Fork from here": the provider copies its record up to just before user message `itemId` into a new Agent Session (in
 * the source Chat's send chain, so no turn starts meanwhile), then a new Session opens it as a Chat. Without `itemId`
 * ("Fork Session") the provider copies its whole record, through the latest turn. The source Chat keeps running
 * unchanged. Logs `agent_chat.forked` with a closed outcome and the malformed record lines the provider skipped;
 * `orphaned` marks a failure after the provider already wrote the forked record, which then stays in the provider's
 * store with no Session to open it (#1750).
 */
export async function forkChat(
    host: ChatForkHost,
    terminalId: string,
    itemId: string | undefined,
    createSession: CreateForkSession,
): Promise<{ sessionId: string; terminalId: string }> {
    const { database, logger } = host.options;
    const terminal = requireChatTerminal(database, terminalId);
    const { provider } = terminal;
    const startedAt = Date.now();
    let keptTurns: number | undefined;
    let skippedRecords: number | undefined;
    let agentSessionId: string | undefined;
    const log = (outcome: 'failed' | 'forked' | 'refused', code: string | null = null): void =>
        logger.write('info', logEventCatalog.agentChat.forked, {
            fields: {
                terminalId,
                provider,
                outcome,
                code,
                keptTurns: keptTurns ?? null,
                skippedRecords: skippedRecords ?? null,
                orphaned: outcome === 'failed' && agentSessionId !== undefined,
                durationMs: Date.now() - startedAt,
            },
        });
    try {
        const projectId = database.getSession(terminal.sessionId)?.projectId;
        if (!projectId) throw new CaxriError('NOT_FOUND', 'Session not found');
        await host.enqueue(terminalId, async (session, state) => {
            const { snapshot } = state.projection;
            const cut = forkCut(snapshot, itemId);
            keptTurns = cut.keptTurns;
            /**
             * Nothing comes before the message, so the new Chat starts a conversation of its own: a provider record
             * without a turn may not be resumable (Codex writes no rollout until the first turn).
             */
            if (keptTurns === 0 && !snapshot.truncated) return;
            const fork = await session.fork(cut.target);
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

import type { AgentChatSnapshot } from './agent-chat-contract.js';

/**
 * Which user messages "Edit from here" can rewind a Chat to. Server Core validates `agentChat.rewind` with the same
 * rule the Renderer uses to offer the action, so the two cannot disagree. See `docs/agent-chat.md`.
 */

/**
 * Why a message cannot be edited from: a turn is running (the provider rewinds only a settled conversation), or the
 * message did not start its turn (a steered message joined a turn that was already running, so there is no point in the
 * provider's record that falls right before it).
 */
export type AgentChatRewindRefusal = 'turnRunning' | 'notTurnStart' | 'unknownMessage';

export interface AgentChatRewindTarget {
    itemId: string;
    /**
     * The turn the message started. It and every later turn are removed.
     */
    turnId: string;
    /**
     * Turns that stay, all of them older than `turnId`. Counts only the turns the projection holds.
     */
    keptTurns: number;
    /**
     * Turns removed, `turnId` included.
     */
    removedTurns: number;
}

type RewindSnapshot = Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'turns'> &
    Partial<Pick<AgentChatSnapshot, 'operation'>>;

function firstUserMessageIds(snapshot: RewindSnapshot): Map<string, string> {
    const firstByTurn = new Map<string, string>();
    for (const item of snapshot.items)
        if (item.type === 'userMessage' && item.turnId && !firstByTurn.has(item.turnId))
            firstByTurn.set(item.turnId, item.id);
    return firstByTurn;
}

/**
 * The rewind `itemId` asks for, or why it is refused.
 */
export function agentChatRewindTarget(
    snapshot: RewindSnapshot,
    itemId: string,
): { target: AgentChatRewindTarget } | { refusal: AgentChatRewindRefusal } {
    const item = snapshot.items.find((candidate) => candidate.id === itemId);
    if (item?.type !== 'userMessage' || !item.turnId) return { refusal: 'unknownMessage' };
    const position = snapshot.turns.findIndex((turn) => turn.id === item.turnId);
    if (position === -1) return { refusal: 'unknownMessage' };
    if (item.delivery === 'steered' || firstUserMessageIds(snapshot).get(item.turnId) !== itemId)
        return { refusal: 'notTurnStart' };
    // A compaction rewrites the provider's record too, so it counts as a running turn.
    if (snapshot.activeTurnId || snapshot.operation === 'compacting')
        return { refusal: 'turnRunning' };
    return {
        target: {
            itemId,
            turnId: item.turnId,
            keptTurns: position,
            removedTurns: snapshot.turns.length - position,
        },
    };
}

/**
 * Ids of the user messages that start a turn the projection knows, which is where "Edit from here" is offered. A
 * running turn does not remove a message from the set: the action stays visible and says why it waits.
 */
export function agentChatRewindableMessageIds(snapshot: RewindSnapshot): Set<string> {
    const turnIds = new Set(snapshot.turns.map((turn) => turn.id));
    const items = new Map(snapshot.items.map((item) => [item.id, item]));
    const ids = new Set<string>();
    for (const [turnId, itemId] of firstUserMessageIds(snapshot)) {
        const item = items.get(itemId);
        if (turnIds.has(turnId) && item?.type === 'userMessage' && item.delivery !== 'steered')
            ids.add(itemId);
    }
    return ids;
}

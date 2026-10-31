import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import { commandPolicy } from '../transport/method-spec.js';
import type { AgentChatSnapshot } from './agent-chat-contract.js';
import { agentChatItemSchema, agentChatTurnSchema } from './agent-chat-contract.js';
import { MAX_AGENT_CHAT_ITEMS } from './agent-chat-limits.js';

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

/**
 * Earlier versions of a Chat's conversation: what "Edit from here" replaced, kept by Server Core and shown read-only
 * behind the edited message's version switcher. See `docs/agent-chat.md`.
 */

/**
 * Versions one Chat keeps, oldest dropped first.
 */
export const MAX_AGENT_CHAT_VERSIONS = 100;

/**
 * The stored JSON one Chat's versions may hold together, oldest dropped first. One version is at most one projection
 * (`MAX_AGENT_CHAT_TOTAL_TEXT_LENGTH` of text), so this keeps a dozen full ones.
 */
export const MAX_AGENT_CHAT_VERSION_BYTES = 64 * 1024 * 1024;

/**
 * One earlier version without its content. `anchorTurnId` is the last turn that version shares with the conversation it
 * branched from, or null when it replaced the conversation's first message: the switcher sits on the user message that
 * starts the turn right after it. `parentVersionId` is the earlier version whose content holds that turn, null when it
 * is the conversation that continues.
 */
const agentChatVersionSummarySchema = z.strictObject({
    id: z.string().min(1).max(200),
    parentVersionId: z.string().min(1).max(200).nullable(),
    anchorTurnId: z.string().min(1).max(200).nullable(),
    createdAt: z.number().int().nonnegative(),
});

/**
 * One earlier version's items and turns, from its edited message on, oldest first.
 */
export const agentChatVersionContentSchema = z.strictObject({
    items: z.array(agentChatItemSchema).max(MAX_AGENT_CHAT_ITEMS),
    turns: z.array(agentChatTurnSchema).max(MAX_AGENT_CHAT_ITEMS),
});

export type AgentChatVersionSummary = z.infer<typeof agentChatVersionSummarySchema>;
export type AgentChatVersionContent = z.infer<typeof agentChatVersionContentSchema>;

/**
 * The `agentChat.*` methods that read a Chat's earlier versions.
 */
export const agentChatVersionMethods = {
    /**
     * The earlier versions "Edit from here" kept for the Chat's current conversation, oldest first, without their
     * content. A version of another conversation (the Chat started a new Agent Session since) is left out. Read again
     * when the snapshot's `historyId` changes, since every rewind replaces the history.
     */
    'agentChat.listVersions': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({ terminalId: identifierSchema }),
        result: z.array(agentChatVersionSummarySchema).max(MAX_AGENT_CHAT_VERSIONS),
    },
    /**
     * One earlier version's items and turns, read when the user switches to it. Fails with `NOT_FOUND` for a version
     * the Chat no longer keeps.
     */
    'agentChat.readVersion': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({
            terminalId: identifierSchema,
            versionId: agentChatVersionSummarySchema.shape.id,
        }),
        result: agentChatVersionContentSchema,
    },
};

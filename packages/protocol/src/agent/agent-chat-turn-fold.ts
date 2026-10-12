import type { AgentChatItem } from './agent-chat-contract.js';
import { isAgentChatItemVisible } from './agent-chat-presentation.js';

/**
 * One piece of a finished turn as every Chat client folds it: an item that stays in view (`kept`), or the turn's work
 * and commentary gathered behind its `Worked for` row (`fold`). A turn has at most one `fold`.
 */
export type AgentChatTurnFoldPart =
    { kind: 'kept'; item: AgentChatItem } | { kind: 'fold'; items: readonly AgentChatItem[] };

/**
 * The id of a turn's final reply: its last visible Agent message. A loop rather than `findLast`, which the phone's
 * ES2022 runtime library does not declare.
 */
export function agentChatFinalReplyId(items: readonly AgentChatItem[]): string | undefined {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item.type === 'agentMessage' && isAgentChatItemVisible(item)) return item.id;
    }
    return undefined;
}

/**
 * Folds a finished turn's visible items the way Codex and T3 Code end a turn. The prompt, the final reply, and the
 * notices (an error, a compaction, an answered question) stay in view; a transient retry notice, the work, and the
 * commentary before the reply fold into one part at the position of the first folded item. A turn with nothing to fold
 * comes back as `kept` parts only. Desktop and the phone share this rule so a turn folds the same on both.
 */
export function foldAgentChatTurn(
    visible: readonly AgentChatItem[],
    finalReplyId: string | undefined,
): AgentChatTurnFoldPart[] {
    const isKept = (item: AgentChatItem): boolean =>
        item.type === 'userMessage' ||
        (finalReplyId !== undefined && item.id === finalReplyId) ||
        (item.type === 'notice' && item.kind !== 'retrying');
    const folded = visible.filter((item) => !isKept(item));
    const parts: AgentChatTurnFoldPart[] = [];
    let hasFold = false;
    for (const item of visible) {
        if (isKept(item)) {
            parts.push({ kind: 'kept', item });
            continue;
        }
        if (hasFold) continue;
        hasFold = true;
        parts.push({ kind: 'fold', items: folded });
    }
    return parts;
}

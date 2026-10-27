import type { AgentChatLabelTranslate } from '../agent-chat-labels.js';
import { translateAgentChatLabel } from '../agent-chat-labels.js';
import type { BotInboxKind } from './caxri-bot-inbox-contract.js';

/**
 * Presentation rules every Bot Inbox surface shares (the Desktop "Needs you" column and the phone's "Needs you"
 * screen), so the same item reads the same way on both.
 */
export function botInboxKindLabel(
    kind: BotInboxKind,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string {
    return t(`caxriBot.inbox.kind.${kind}`);
}

/**
 * Whether the item is a question (`decision` or `hands`) rather than a pull request waiting to merge.
 */
export function isBotInboxQuestion(item: { kind: BotInboxKind }): boolean {
    return item.kind !== 'merge';
}

/**
 * Questions before pull requests, because a question blocks Caxri Bot while a ready pull request only waits. The
 * incoming (newest-first) order is kept within each group.
 */
export function orderBotInboxItems<T extends { kind: BotInboxKind }>(items: readonly T[]): T[] {
    return [
        ...items.filter((item) => isBotInboxQuestion(item)),
        ...items.filter((item) => !isBotInboxQuestion(item)),
    ];
}

/**
 * Whether Caxri Bot has read the owner's latest reply, so a sent answer never looks lost while Caxri Bot is busy.
 * Undefined until the owner replied.
 */
export function botInboxReplyState(
    item: {
        acknowledgedSequence: number;
        replies: ReadonlyArray<{ sequence: number }>;
    },
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): { isRead: boolean; label: string } | undefined {
    const latest = item.replies.at(-1);
    if (!latest) return undefined;
    return item.acknowledgedSequence >= latest.sequence
        ? { isRead: true, label: t('caxriBot.inbox.replyState.read') }
        : { isRead: false, label: t('caxriBot.inbox.replyState.delivered') };
}

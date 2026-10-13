import type { CommanderInboxKind } from './agent-commander-inbox-contract.js';

/**
 * Presentation rules every Commander Inbox surface shares (the Desktop "Needs you" column and the phone's "Needs you"
 * screen), so the same item reads the same way on both.
 */
const KIND_LABELS: Record<CommanderInboxKind, string> = {
    decision: 'Decision',
    hands: 'Needs you',
    merge: 'Pull request',
};

export function commanderInboxKindLabel(kind: CommanderInboxKind): string {
    return KIND_LABELS[kind];
}

/**
 * Whether the item is a question (`decision` or `hands`) rather than a pull request waiting to merge.
 */
export function isCommanderInboxQuestion(item: { kind: CommanderInboxKind }): boolean {
    return item.kind !== 'merge';
}

/**
 * Questions before pull requests, because a question blocks the Commander while a ready pull request only waits. The
 * incoming (newest-first) order is kept within each group.
 */
export function orderCommanderInboxItems<T extends { kind: CommanderInboxKind }>(
    items: readonly T[],
): T[] {
    return [
        ...items.filter((item) => isCommanderInboxQuestion(item)),
        ...items.filter((item) => !isCommanderInboxQuestion(item)),
    ];
}

/**
 * Whether the Commander has read the owner's latest reply, so a sent answer never looks lost while the Commander is
 * busy. Undefined until the owner replied.
 */
export function commanderInboxReplyState(item: {
    acknowledgedSequence: number;
    replies: ReadonlyArray<{ sequence: number }>;
}): { isRead: boolean; label: string } | undefined {
    const latest = item.replies.at(-1);
    if (!latest) return undefined;
    return item.acknowledgedSequence >= latest.sequence
        ? { isRead: true, label: 'Read by Commander' }
        : { isRead: false, label: 'Delivered to Commander' };
}

import type { CommanderInboxItem, CommanderInboxKind } from '@caxri/protocol';

type CommanderInboxSectionId = 'merge' | 'questions';

export interface CommanderInboxSection {
    id: CommanderInboxSectionId;
    title: string;
    items: CommanderInboxItem[];
}

const SECTION_TITLES: Record<CommanderInboxSectionId, string> = {
    merge: 'Ready to merge',
    questions: 'Questions',
};

const KIND_LABELS: Record<CommanderInboxKind, string> = {
    decision: 'Decision',
    hands: 'Needs your hands',
    merge: 'Pull request',
};

export function commanderInboxKindLabel(kind: CommanderInboxKind): string {
    return KIND_LABELS[kind];
}

/**
 * Open items in two sections: questions first, because a question blocks the Commander while a ready pull request only
 * waits. Within each, the Server's newest-first order is kept.
 */
export function commanderInboxSections(
    items: readonly CommanderInboxItem[],
): CommanderInboxSection[] {
    const open = items.filter((item) => item.status === 'open');
    const sections: CommanderInboxSection[] = [];
    for (const id of ['questions', 'merge'] as const) {
        const inSection = open.filter((item) =>
            id === 'merge' ? item.kind === 'merge' : item.kind !== 'merge',
        );
        if (inSection.length > 0)
            sections.push({ id, title: SECTION_TITLES[id], items: inSection });
    }
    return sections;
}

export function openCommanderInboxCount(items: readonly CommanderInboxItem[]): number {
    return items.filter((item) => item.status === 'open').length;
}

export interface CommanderInboxMergeState {
    canMerge: boolean;
    /**
     * Short status shown beside the Merge button; absent when nothing stands in the way.
     */
    label?: string;
    tone?: 'danger' | 'muted' | 'success' | 'warning';
    /**
     * Why Merge is unavailable, for its tooltip.
     */
    reason?: string;
}

/**
 * Whether the owner can merge a `merge` item from the Inbox. Only states that make the pinned merge certain to fail or
 * wrong disable it: a stale report, a draft, or a conflict. Pending or failing checks stay mergeable because the
 * repository's own branch protection decides whether they block, and GitHub answers that on the merge itself.
 */
export function commanderInboxMergeState(item: CommanderInboxItem): CommanderInboxMergeState {
    if (item.staleReason === 'headMoved')
        return {
            canMerge: false,
            label: 'Changed since verified',
            tone: 'warning',
            reason: 'New commits landed after the Commander verified this pull request. It re-verifies before you merge.',
        };
    const live = item.pullRequestLive;
    if (live?.lifecycle === 'draft')
        return {
            canMerge: false,
            label: 'Draft',
            tone: 'muted',
            reason: 'The pull request is still a draft.',
        };
    if (live?.mergeState === 'conflicting')
        return {
            canMerge: false,
            label: 'Conflicts',
            tone: 'danger',
            reason: 'The pull request conflicts with its base branch.',
        };
    if (!live) return { canMerge: true, label: 'GitHub state unknown', tone: 'muted' };
    if (live.checks === 'failure')
        return { canMerge: true, label: 'Checks failing', tone: 'danger' };
    if (live.checks === 'pending')
        return { canMerge: true, label: 'Checks running', tone: 'muted' };
    if (live.mergeState === 'blocked') return { canMerge: true, label: 'Blocked', tone: 'warning' };
    if (live.mergeState === 'behind')
        return { canMerge: true, label: 'Behind base', tone: 'warning' };
    return { canMerge: true, label: 'Checks passed', tone: 'success' };
}

/**
 * Whether the Commander has read the owner's latest reply, so a sent answer never looks lost while the Commander is
 * busy. Undefined until the owner replied.
 */
export function commanderInboxReplyState(
    item: CommanderInboxItem,
): { isRead: boolean; label: string } | undefined {
    const latest = item.replies.at(-1);
    if (!latest) return undefined;
    return item.acknowledgedSequence >= latest.sequence
        ? { isRead: true, label: 'Read by Commander' }
        : { isRead: false, label: 'Delivered to Commander' };
}

/**
 * The `@` mention the caret is inside, if any: an `@` at the start or after whitespace, followed by the query typed so
 * far with no whitespace. `start` is the index of the `@`.
 */
export function activeInboxMention(
    text: string,
    caret: number,
): { query: string; start: number } | undefined {
    const before = text.slice(0, caret);
    const match = /(?:^|\s)@([^\s@]*)$/u.exec(before);
    if (!match) return undefined;
    return { query: match[1], start: caret - match[1].length - 1 };
}

/**
 * Open items whose title or kind contains the query, case-insensitively, in Inbox order.
 */
export function inboxMentionCandidates(
    items: readonly CommanderInboxItem[],
    query: string,
): CommanderInboxItem[] {
    const needle = query.toLocaleLowerCase();
    return items.filter(
        (item) =>
            item.status === 'open' &&
            (needle === '' ||
                item.title.toLocaleLowerCase().includes(needle) ||
                KIND_LABELS[item.kind].toLocaleLowerCase().includes(needle)),
    );
}

/**
 * Removes the `@query` token once it was turned into a reply target, so the reply text carries only the answer.
 */
export function removeInboxMention(
    text: string,
    mention: { start: number },
    caret: number,
): { caret: number; text: string } {
    return { text: text.slice(0, mention.start) + text.slice(caret), caret: mention.start };
}

/**
 * The item a reply goes to: the chosen one while it is still open, otherwise the only open question, so the common case
 * of one pending question needs no `@` at all.
 */
export function inboxReplyTarget(
    items: readonly CommanderInboxItem[],
    chosenId: string | undefined,
): CommanderInboxItem | undefined {
    const open = items.filter((item) => item.status === 'open');
    const chosen = chosenId && open.find((item) => item.id === chosenId);
    if (chosen) return chosen;
    const questions = open.filter((item) => item.kind !== 'merge');
    return questions.length === 1 ? questions[0] : undefined;
}

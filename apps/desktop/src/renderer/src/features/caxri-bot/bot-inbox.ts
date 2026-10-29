import type { BotInboxItem } from '@caxri/protocol';
import { botInboxKindLabel, isBotInboxQuestion } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import type { CaretMention, SuggestionOption } from '../../lib/suggestion-options';

type BotInboxSectionId = 'merge' | 'questions';

export interface BotInboxSection {
    id: BotInboxSectionId;
    title: string;
    items: BotInboxItem[];
}

const SECTION_TITLE_KEYS: Record<BotInboxSectionId, TranslationKey> = {
    merge: 'caxriBot.inbox.section.merge',
    questions: 'caxriBot.inbox.section.questions',
};

/**
 * Open items in two sections, questions first (the order `orderBotInboxItems` shares with the phone). Within each, the
 * Server's newest-first order is kept.
 */
export function botInboxSections(items: readonly BotInboxItem[], t: Translate): BotInboxSection[] {
    const open = items.filter((item) => item.status === 'open');
    const sections: BotInboxSection[] = [];
    for (const id of ['questions', 'merge'] as const) {
        const inSection = open.filter((item) => isBotInboxQuestion(item) === (id === 'questions'));
        if (inSection.length > 0)
            sections.push({ id, title: t(SECTION_TITLE_KEYS[id]), items: inSection });
    }
    return sections;
}

/**
 * The open items a badge counts. `dismissingIds` are items dismissed but still inside their Undo window: the list
 * already hides them, so the count must too.
 */
export function openBotInboxCount(
    items: readonly BotInboxItem[],
    dismissingIds: Readonly<Record<string, true>> = {},
): number {
    return items.filter((item) => item.status === 'open' && !Object.hasOwn(dismissingIds, item.id))
        .length;
}

export interface BotInboxMergeState {
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
export function botInboxMergeState(item: BotInboxItem, t: Translate): BotInboxMergeState {
    if (item.staleReason === 'headMoved')
        return {
            canMerge: false,
            label: t('caxriBot.mergeState.changedSinceVerified'),
            tone: 'warning',
            reason: t('caxriBot.mergeState.changedSinceVerifiedReason'),
        };
    const live = item.pullRequestLive;
    if (live?.lifecycle === 'draft')
        return {
            canMerge: false,
            label: t('caxriBot.mergeState.draft'),
            tone: 'muted',
            reason: t('caxriBot.mergeState.draftReason'),
        };
    if (live?.mergeState === 'conflicting')
        return {
            canMerge: false,
            label: t('caxriBot.mergeState.conflicts'),
            tone: 'danger',
            reason: t('caxriBot.mergeState.conflictsReason'),
        };
    if (!live) return { canMerge: true, label: t('caxriBot.mergeState.unknown'), tone: 'muted' };
    if (live.checks === 'failure')
        return {
            canMerge: true,
            label: t('caxriBot.mergeState.checksFailing'),
            tone: 'danger',
        };
    if (live.checks === 'pending')
        return {
            canMerge: true,
            label: t('caxriBot.mergeState.checksRunning'),
            tone: 'muted',
        };
    if (live.mergeState === 'blocked')
        return { canMerge: true, label: t('caxriBot.mergeState.blocked'), tone: 'warning' };
    if (live.mergeState === 'behind')
        return {
            canMerge: true,
            label: t('caxriBot.mergeState.behindBase'),
            tone: 'warning',
        };
    return { canMerge: true, label: t('caxriBot.mergeState.checksPassed'), tone: 'success' };
}

/**
 * Open items whose title or kind contains the query, case-insensitively, in Inbox order.
 */
export function inboxMentionCandidates(
    items: readonly BotInboxItem[],
    query: string,
    t: Translate,
): BotInboxItem[] {
    const needle = query.toLocaleLowerCase();
    return items.filter(
        (item) =>
            item.status === 'open' &&
            (needle === '' ||
                item.title.toLocaleLowerCase().includes(needle) ||
                botInboxKindLabel(item.kind, t).toLocaleLowerCase().includes(needle)),
    );
}

/**
 * Removes the `@query` token once it was turned into a reply target, so the reply text carries only the answer.
 */
export function removeInboxMention(
    text: string,
    mention: Pick<CaretMention, 'end' | 'start'>,
): { caret: number; text: string } {
    return { text: text.slice(0, mention.start) + text.slice(mention.end), caret: mention.start };
}

/**
 * Starts an `@` mention at the caret, so Enter on a reply with no item to answer opens the picker instead of doing
 * nothing. The `@` gets a space before it when it would otherwise join the word at the caret, because only an `@` that
 * begins a word opens the picker; choosing an item removes the `@` again and leaves the typed answer intact.
 */
export function insertInboxMentionTrigger(
    text: string,
    caret: number,
): { caret: number; text: string } {
    const before = text.slice(0, caret);
    const trigger = before === '' || /\s$/u.test(before) ? '@' : ' @';
    return { text: before + trigger + text.slice(caret), caret: caret + trigger.length };
}

/**
 * An `@` picker row for an Inbox item: its title, with its kind beside it.
 */
export function inboxMentionSuggestion(item: BotInboxItem, t: Translate): SuggestionOption {
    return {
        key: item.id,
        label: item.title,
        isLabelLiteral: false,
        description: botInboxKindLabel(item.kind, t),
    };
}

/**
 * The item a reply goes to: the chosen one while it is still open, otherwise the only open question, so the common case
 * of one pending question needs no `@` at all. A chosen item that closed yields no target rather than the fallback, so
 * an answer typed for it is never sent to a different question.
 */
export function inboxReplyTarget(
    items: readonly BotInboxItem[],
    chosenId: string | undefined,
): BotInboxItem | undefined {
    const open = items.filter((item) => item.status === 'open');
    if (chosenId) return open.find((item) => item.id === chosenId);
    const questions = open.filter((item) => isBotInboxQuestion(item));
    return questions.length === 1 ? questions[0] : undefined;
}

/**
 * The composer's Send tooltip. While Send cannot send it says why, as the Agent Chat composer does, instead of
 * advertising a shortcut that does nothing: a reply needs an item to answer, chosen with `@`, and some text.
 */
export function inboxSendTooltip(
    { draft, hasTarget }: { draft: string; hasTarget: boolean },
    t: Translate,
): string {
    if (!hasTarget) return t('caxriBot.composer.sendNeedsTarget');
    if (draft.trim() === '') return t('caxriBot.composer.sendNeedsText');
    return t('caxriBot.composer.sendTooltip');
}

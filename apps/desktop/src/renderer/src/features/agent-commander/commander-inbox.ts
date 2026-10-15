import type { CommanderInboxItem } from '@caxri/protocol';
import { commanderInboxKindLabel, isCommanderInboxQuestion } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import { translate } from '../../i18n';
import type { CaretMention, SuggestionOption } from '../../lib/suggestion-options';

type CommanderInboxSectionId = 'merge' | 'questions';

export interface CommanderInboxSection {
    id: CommanderInboxSectionId;
    title: string;
    items: CommanderInboxItem[];
}

const SECTION_TITLE_KEYS: Record<CommanderInboxSectionId, TranslationKey> = {
    merge: 'agentCommander.inbox.section.merge',
    questions: 'agentCommander.inbox.section.questions',
};

/**
 * Open items in two sections, questions first (the order `orderCommanderInboxItems` shares with the phone). Within
 * each, the Server's newest-first order is kept.
 */
export function commanderInboxSections(
    items: readonly CommanderInboxItem[],
    t: Translate = translate,
): CommanderInboxSection[] {
    const open = items.filter((item) => item.status === 'open');
    const sections: CommanderInboxSection[] = [];
    for (const id of ['questions', 'merge'] as const) {
        const inSection = open.filter(
            (item) => isCommanderInboxQuestion(item) === (id === 'questions'),
        );
        if (inSection.length > 0)
            sections.push({ id, title: t(SECTION_TITLE_KEYS[id]), items: inSection });
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
export function commanderInboxMergeState(
    item: CommanderInboxItem,
    t: Translate = translate,
): CommanderInboxMergeState {
    if (item.staleReason === 'headMoved')
        return {
            canMerge: false,
            label: t('agentCommander.mergeState.changedSinceVerified'),
            tone: 'warning',
            reason: t('agentCommander.mergeState.changedSinceVerifiedReason'),
        };
    const live = item.pullRequestLive;
    if (live?.lifecycle === 'draft')
        return {
            canMerge: false,
            label: t('agentCommander.mergeState.draft'),
            tone: 'muted',
            reason: t('agentCommander.mergeState.draftReason'),
        };
    if (live?.mergeState === 'conflicting')
        return {
            canMerge: false,
            label: t('agentCommander.mergeState.conflicts'),
            tone: 'danger',
            reason: t('agentCommander.mergeState.conflictsReason'),
        };
    if (!live)
        return { canMerge: true, label: t('agentCommander.mergeState.unknown'), tone: 'muted' };
    if (live.checks === 'failure')
        return {
            canMerge: true,
            label: t('agentCommander.mergeState.checksFailing'),
            tone: 'danger',
        };
    if (live.checks === 'pending')
        return {
            canMerge: true,
            label: t('agentCommander.mergeState.checksRunning'),
            tone: 'muted',
        };
    if (live.mergeState === 'blocked')
        return { canMerge: true, label: t('agentCommander.mergeState.blocked'), tone: 'warning' };
    if (live.mergeState === 'behind')
        return {
            canMerge: true,
            label: t('agentCommander.mergeState.behindBase'),
            tone: 'warning',
        };
    return { canMerge: true, label: t('agentCommander.mergeState.checksPassed'), tone: 'success' };
}

/**
 * Open items whose title or kind contains the query, case-insensitively, in Inbox order.
 */
export function inboxMentionCandidates(
    items: readonly CommanderInboxItem[],
    query: string,
    t: Translate = translate,
): CommanderInboxItem[] {
    const needle = query.toLocaleLowerCase();
    return items.filter(
        (item) =>
            item.status === 'open' &&
            (needle === '' ||
                item.title.toLocaleLowerCase().includes(needle) ||
                commanderInboxKindLabel(item.kind, t).toLocaleLowerCase().includes(needle)),
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
export function inboxMentionSuggestion(
    item: CommanderInboxItem,
    t: Translate = translate,
): SuggestionOption {
    return {
        key: item.id,
        label: item.title,
        isLabelLiteral: false,
        description: commanderInboxKindLabel(item.kind, t),
    };
}

/**
 * The item a reply goes to: the chosen one while it is still open, otherwise the only open question, so the common case
 * of one pending question needs no `@` at all. A chosen item that closed yields no target rather than the fallback, so
 * an answer typed for it is never sent to a different question.
 */
export function inboxReplyTarget(
    items: readonly CommanderInboxItem[],
    chosenId: string | undefined,
): CommanderInboxItem | undefined {
    const open = items.filter((item) => item.status === 'open');
    if (chosenId) return open.find((item) => item.id === chosenId);
    const questions = open.filter((item) => isCommanderInboxQuestion(item));
    return questions.length === 1 ? questions[0] : undefined;
}

/**
 * The composer's Send tooltip. While Send cannot send it says why, as the Agent Chat composer does, instead of
 * advertising a shortcut that does nothing: a reply needs an item to answer, chosen with `@`, and some text.
 */
export function inboxSendTooltip(
    { draft, hasTarget }: { draft: string; hasTarget: boolean },
    t: Translate = translate,
): string {
    if (!hasTarget) return t('agentCommander.composer.sendNeedsTarget');
    if (draft.trim() === '') return t('agentCommander.composer.sendNeedsText');
    return t('agentCommander.composer.sendTooltip');
}

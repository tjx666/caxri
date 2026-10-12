import type { KeyboardEvent, RefObject } from 'react';
import { useEffect, useId, useMemo, useState } from 'react';

import { isImeComposing } from '../../../lib/ime';
import { suggestionMenuKeyAction, suggestionOptionId } from '../../../lib/suggestion-options';
import { useProjects, useSessions } from '../../../stores/selectors';
import type { SessionReferenceCandidate } from '../../session/session-reference';
import { searchSessionReferences } from '../../session/session-reference';
import { prepareSessionReference } from '../../session/session-reference-commands';
import { draftWithInsertion } from '../agent-chat-drafts';
import {
    agentChatSessionEmptyText,
    agentChatSessionPreparingText,
    agentChatSessionSuggestion,
    agentChatSessionSuggestions,
} from '../agent-chat-suggestions';
import { useAgentChatPlacedCaret } from './use-agent-chat-placed-caret';

/**
 * The `@` Sessions list: typing `@` at the start of a word offers the other Sessions with an Agent conversation,
 * searched by title, each with its Project and, when titles repeat, when it was last opened. A query with no match
 * keeps the list open on a `No Sessions match` row, as the slash-command list does. Choosing one asks the Server to
 * condense that conversation into a reference file and replaces the typed `@word` with `@<path>` and a sentence saying
 * whose conversation it is; meanwhile the list shows a progress row naming the Session (`preparing`), and Enter waits
 * rather than sending the half-typed `@word`. Keys match the slash-command list: arrows move, Enter or Tab chooses,
 * Escape dismisses until the next edit. The list shows only while the input has focus, so it never covers another
 * surface, and waits for the user to edit the draft or move the caret, so showing a Chat whose restored draft ends in
 * `@word` does not open it.
 */
export function useAgentChatSessionMenu({
    currentSessionId,
    draft,
    inputReference,
    isInputFocused,
    isShown,
    isSuppressed,
    setDraft,
}: {
    currentSessionId: string | undefined;
    draft: string;
    inputReference: RefObject<HTMLTextAreaElement | null>;
    isInputFocused: boolean;
    /**
     * Whether the Chat is on screen in the active pane. A Chat stays mounted while its Session is hidden, so hiding it
     * is what ends the caret the user placed.
     */
    isShown: boolean;
    /**
     * The slash-command list is open; it owns the keys and the space above the input.
     */
    isSuppressed: boolean;
    setDraft: (update: (current: string) => string) => void;
}) {
    const listId = useId();
    // The list follows the word at the caret rather than the whole draft, and only a caret the user placed.
    const { mention, setCaret, ...caretTracking } = useAgentChatPlacedCaret(draft, isShown);
    const sessions = useSessions();
    const projects = useProjects();
    const [dismissedDraft, setDismissedDraft] = useState<string>();
    /**
     * The title of the Session whose reference is being written, or `undefined` when none is.
     */
    const [preparing, setPreparing] = useState<string>();
    const isPreparing = preparing !== undefined;
    // Reset during render, as the slash-command list does: the dismissal ends at the first edit.
    if (dismissedDraft !== undefined && dismissedDraft !== draft) setDismissedDraft(undefined);
    const candidates = mention
        ? searchSessionReferences(sessions, projects, currentSessionId, mention.query)
        : [];
    const openedAt = useMemo(
        () => new Map(sessions?.map((session) => [session.id, session.lastOpenedAt])),
        [sessions],
    );
    const [active, setActive] = useState({ query: mention?.query, index: 0 });
    const isVisible = isInputFocused && !isSuppressed;
    const isOpen = mention !== undefined && dismissedDraft !== draft && !isPreparing && isVisible;
    const activeIndex =
        active.query === mention?.query ? Math.min(active.index, candidates.length - 1) : 0;
    const activeCandidate = isOpen ? candidates[activeIndex] : undefined;
    const activeOptionId = activeCandidate
        ? suggestionOptionId(listId, agentChatSessionSuggestion(activeCandidate).key)
        : undefined;
    useEffect(() => {
        if (!activeOptionId) return;
        document
            .querySelector(`#${CSS.escape(activeOptionId)}`)
            ?.scrollIntoView({ block: 'nearest' });
    }, [activeOptionId]);

    const choose = async (candidate: SessionReferenceCandidate): Promise<void> => {
        if (!mention || isPreparing) return;
        const typed = draft.slice(mention.start, mention.end);
        setPreparing(candidate.title);
        const reference = await prepareSessionReference(candidate.sessionId);
        setPreparing(undefined);
        const textarea = inputReference.current;
        if (!reference || !textarea) return;
        // The user may have kept typing while the file was written; replace the mention only if it is still there.
        const current = textarea.value;
        const range =
            current.slice(mention.start, mention.end) === typed
                ? mention
                : { start: current.length, end: current.length };
        const inserted = draftWithInsertion(current, range.start, range.end, reference);
        setDraft(() => inserted.draft);
        // A programmatic draft change fires no select event; without this the stale caret still sits inside the
        // inserted `@<path>` and reopens the list on its "No Sessions match" row.
        setCaret(inserted.caret);
        requestAnimationFrame(() => {
            textarea.focus();
            textarea.setSelectionRange(inserted.caret, inserted.caret);
        });
    };

    return {
        activeIndex,
        emptyText: agentChatSessionEmptyText(mention?.query ?? ''),
        isOpen,
        /**
         * Whether a chosen Session's reference is still being written, which holds Send.
         */
        isPreparing,
        listId,
        /**
         * The progress row shown in place of the list while the reference is written.
         */
        preparingText:
            preparing !== undefined && isVisible
                ? agentChatSessionPreparingText(preparing)
                : undefined,
        suggestions: agentChatSessionSuggestions(candidates, openedAt),
        inputAria: isOpen
            ? {
                  'aria-activedescendant': activeOptionId,
                  'aria-autocomplete': 'list' as const,
                  'aria-controls': listId,
              }
            : undefined,
        ...caretTracking,
        highlight: (index: number) => setActive({ query: mention?.query, index }),
        chooseAt: (index: number) => {
            const candidate = candidates.at(index);
            // eslint-disable-next-line no-void -- prepareSessionReference reports its own failures through tryCommand
            if (candidate) void choose(candidate);
        },
        /**
         * Returns whether the key was the list's, so the composer skips its own handling (Enter must not send the
         * half-typed `@word`).
         */
        didHandleKey: (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
            if (isImeComposing(event)) return false;
            // While the chosen Session's reference is written, Enter would send the half-typed `@word` and the
            // reference would then land in the next message.
            if (isPreparing && event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                return true;
            }
            if (!isOpen) return false;
            const action = suggestionMenuKeyAction(event);
            // With no row to choose, only Escape is the list's; Enter still sends the draft.
            if (!action || (action !== 'dismiss' && !activeCandidate)) return false;
            event.preventDefault();
            if (action === 'next' || action === 'previous') {
                const delta = action === 'next' ? 1 : -1;
                setActive({
                    query: mention.query,
                    index: (activeIndex + delta + candidates.length) % candidates.length,
                });
            } else if (action === 'dismiss') setDismissedDraft(draft);
            // eslint-disable-next-line no-void -- prepareSessionReference reports its own failures through tryCommand
            else if (activeCandidate) void choose(activeCandidate);
            return true;
        },
    };
}

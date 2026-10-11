import type { KeyboardEvent, RefObject } from 'react';
import { useEffect, useId, useState } from 'react';

import { useProjects, useSessions } from '../../../stores/selectors';
import type { SessionReferenceCandidate } from '../../session/session-reference';
import { searchSessionReferences } from '../../session/session-reference';
import { prepareSessionReference } from '../../session/session-reference-commands';
import { draftWithInsertion } from '../agent-chat-drafts';
import { agentChatMenuKeyAction } from '../agent-chat-slash-commands';
import {
    agentChatMentionAt,
    agentChatSessionSuggestion,
    agentChatSuggestionOptionId,
} from '../agent-chat-suggestions';

/**
 * The `@` Sessions list: typing `@` at the start of a word offers the other Sessions with an Agent conversation,
 * searched by title. Choosing one asks the Server to condense that conversation into a reference file and replaces the
 * typed `@word` with `@<path>` and a sentence saying whose conversation it is. Keys match the slash-command list:
 * arrows move, Enter or Tab chooses, Escape dismisses until the next edit.
 */
export function useAgentChatSessionMenu({
    caret,
    currentSessionId,
    draft,
    inputReference,
    setDraft,
}: {
    caret: number;
    currentSessionId: string | undefined;
    draft: string;
    inputReference: RefObject<HTMLTextAreaElement | null>;
    setDraft: (update: (current: string) => string) => void;
}) {
    const listId = useId();
    const sessions = useSessions();
    const projects = useProjects();
    const mention = agentChatMentionAt(draft, caret);
    const [dismissedDraft, setDismissedDraft] = useState<string>();
    const [isPreparing, setIsPreparing] = useState(false);
    // Reset during render, as the slash-command list does: the dismissal ends at the first edit.
    if (dismissedDraft !== undefined && dismissedDraft !== draft) setDismissedDraft(undefined);
    const candidates = mention
        ? searchSessionReferences(sessions, projects, currentSessionId, mention.query)
        : [];
    const [active, setActive] = useState({ query: mention?.query, index: 0 });
    const isOpen = candidates.length > 0 && dismissedDraft !== draft && !isPreparing;
    const activeIndex =
        active.query === mention?.query ? Math.min(active.index, candidates.length - 1) : 0;
    const activeCandidate = isOpen ? candidates[activeIndex] : undefined;
    const activeOptionId = activeCandidate
        ? agentChatSuggestionOptionId(listId, agentChatSessionSuggestion(activeCandidate).key)
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
        setIsPreparing(true);
        const reference = await prepareSessionReference(candidate.sessionId);
        setIsPreparing(false);
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
        requestAnimationFrame(() => {
            textarea.focus();
            textarea.setSelectionRange(inserted.caret, inserted.caret);
        });
    };

    return {
        activeIndex,
        isOpen,
        listId,
        suggestions: candidates.map(agentChatSessionSuggestion),
        inputAria: isOpen
            ? {
                  'aria-activedescendant': activeOptionId,
                  'aria-autocomplete': 'list' as const,
                  'aria-controls': listId,
              }
            : undefined,
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
            if (event.nativeEvent.isComposing) return false;
            // While the chosen Session's reference is written, Enter would send the half-typed `@word` and the
            // reference would then land in the next message.
            if (isPreparing && event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                return true;
            }
            if (!activeCandidate) return false;
            const action = agentChatMenuKeyAction(event);
            if (!action) return false;
            event.preventDefault();
            if (action === 'next' || action === 'previous') {
                const delta = action === 'next' ? 1 : -1;
                setActive({
                    query: mention?.query,
                    index: (activeIndex + delta + candidates.length) % candidates.length,
                });
            } else if (action === 'dismiss') setDismissedDraft(draft);
            // eslint-disable-next-line no-void -- prepareSessionReference reports its own failures through tryCommand
            else void choose(activeCandidate);
            return true;
        },
    };
}

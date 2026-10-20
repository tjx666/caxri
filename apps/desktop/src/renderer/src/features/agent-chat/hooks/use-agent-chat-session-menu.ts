import type { RefObject } from 'react';
import { useEffect, useId, useMemo, useState } from 'react';

import { isImeComposing } from '../../../lib/ime';
import { suggestionMenuKeyAction, suggestionOptionId } from '../../../lib/suggestion-options';
import { useProjects, useSessions } from '../../../stores/selectors';
import type { SessionReferenceCandidate } from '../../session/session-reference';
import { searchSessionReferences } from '../../session/session-reference';
import { prepareSessionReference } from '../../session/session-reference-commands';
import type {
    AgentChatComposerInput,
    AgentChatComposerKeyEvent,
} from '../composer/agent-chat-composer-view';
import { draftWithInsertion } from '../composer-input/agent-chat-drafts';
import type { AgentChatMentionRow } from '../composer-input/agent-chat-file-mentions';
import {
    agentChatFileSuggestion,
    agentChatMentionActiveIndex,
    agentChatMentionHeadingAt,
    agentChatMentionRows,
    agentChatMentionRowSuggestion,
    agentChatMentionStep,
    formatAgentChatFileMention,
} from '../composer-input/agent-chat-file-mentions';
import {
    agentChatSessionPreparingText,
    agentChatSessionSuggestions,
} from '../composer-input/agent-chat-suggestions';
import { useAgentChatFileMentions } from './use-agent-chat-file-mentions';
import { useAgentChatPlacedCaret } from './use-agent-chat-placed-caret';

/**
 * The `@` list: typing `@` at the start of a word offers a `Files` group, the Project files whose path contains the
 * word (`useAgentChatFileMentions`; the files open in Editor tabs for a bare `@`), then a `Sessions` group, the other
 * Sessions with an Agent conversation, searched by title, each with its Project and, when titles repeat, when it was
 * last opened. A group with no match is left out, and with neither the list stays closed. Choosing a file replaces the
 * typed `@word` with `@<Project-relative path>`, quoted when the path holds whitespace. Choosing a Session asks the
 * Server to condense that conversation into a reference file and replaces the typed `@word` with `@<path>` and a
 * sentence saying whose conversation it is; meanwhile the list shows a progress row naming the Session (`preparing`),
 * and Enter waits rather than sending the half-typed `@word`. Keys match the slash-command list: arrows move, Enter or
 * Tab chooses, Escape dismisses until the next edit. The list shows only while the input has focus, so it never covers
 * another surface, and waits for the user to edit the draft or move the caret, so showing a Chat whose restored draft
 * ends in `@word` does not open it.
 */
export function useAgentChatSessionMenu({
    currentSessionId,
    draft,
    inputReference,
    isInputFocused,
    isShown,
    isSuppressed,
    root,
    setDraft,
}: {
    currentSessionId: string | undefined;
    draft: string;
    inputReference: RefObject<AgentChatComposerInput | null>;
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
    /**
     * Where the Agent runs, which turns open Editor tabs' paths into Project-relative ones for an empty `@`.
     */
    root: string | undefined;
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
    const isListable =
        mention !== undefined && dismissedDraft !== draft && !isPreparing && isVisible;
    const { files } = useAgentChatFileMentions({
        isEnabled: isListable,
        query: mention?.query ?? '',
        root,
        sessionId: currentSessionId,
    });
    const rows = agentChatMentionRows(files, candidates);
    const isOpen = isListable && rows.length > 0;
    const activeIndex = agentChatMentionActiveIndex(active, mention?.query, rows.length);
    const activeRow = isOpen ? rows[activeIndex] : undefined;
    const activeOptionId = activeRow
        ? suggestionOptionId(listId, agentChatMentionRowSuggestion(activeRow).key)
        : undefined;
    useEffect(() => {
        if (!activeOptionId) return;
        document
            .querySelector(`#${CSS.escape(activeOptionId)}`)
            ?.scrollIntoView({ block: 'nearest' });
    }, [activeOptionId]);

    /**
     * Writes the Session's reference file, then puts `@<path>` over `range` of the draft. The user may keep typing
     * while the file is written, so the range is used only while it still holds the text it held when chosen; otherwise
     * the reference goes at the end.
     */
    const insertReference = async (
        candidate: SessionReferenceCandidate,
        range: { start: number; end: number },
        typed: string,
    ): Promise<void> => {
        setPreparing(candidate.title);
        const reference = await prepareSessionReference(candidate.sessionId);
        setPreparing(undefined);
        if (reference) insertText(reference, range, typed);
    };
    /**
     * Puts `text` over `range` of the draft, then the caret after it. The user may keep typing while a Session's
     * reference is written, so the range is used only while it still holds `typed`; otherwise the text goes at the
     * end.
     */
    function insertText(text: string, range: { start: number; end: number }, typed: string): void {
        const input = inputReference.current;
        if (!input) return;
        const current = input.value;
        const target =
            current.slice(range.start, range.end) === typed
                ? range
                : { start: current.length, end: current.length };
        const inserted = draftWithInsertion(current, target.start, target.end, text);
        setDraft(() => inserted.draft);
        // A programmatic draft change fires no select event; without this the stale caret still sits inside the
        // inserted `@<path>` and reopens the list on its "No Sessions match" row.
        setCaret(inserted.caret);
        requestAnimationFrame(() => {
            input.focus();
            input.setSelectionRange(inserted.caret, inserted.caret);
        });
    }

    const chooseRow = (row: AgentChatMentionRow | undefined): void => {
        if (!mention || isPreparing || !row) return;
        const typed = draft.slice(mention.start, mention.end);
        if (row.kind === 'file') insertText(formatAgentChatFileMention(row.path), mention, typed);
        // eslint-disable-next-line no-void -- prepareSessionReference reports its own failures through tryCommand
        else void insertReference(row.candidate, mention, typed);
    };

    return {
        activeIndex,
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
        /**
         * Which group heading the row at `index` starts, or `undefined` when it continues the group above it.
         */
        groupAt: (index: number) => agentChatMentionHeadingAt(files.length, index),
        suggestions: [
            ...files.map((path) => agentChatFileSuggestion(path)),
            ...agentChatSessionSuggestions(candidates, openedAt),
        ],
        inputAria: isOpen
            ? {
                  'aria-activedescendant': activeOptionId,
                  'aria-autocomplete': 'list' as const,
                  'aria-controls': listId,
              }
            : undefined,
        ...caretTracking,
        /**
         * The most recently opened Sessions the composer's Add menu offers, as the empty `@` list would.
         */
        recentCandidates: (limit: number): SessionReferenceCandidate[] =>
            searchSessionReferences(sessions, projects, currentSessionId, '').slice(0, limit),
        /**
         * Cites a Session chosen outside the `@` list (the Add menu) at the input's caret, replacing any selection.
         */
        reference: (candidate: SessionReferenceCandidate): void => {
            const input = inputReference.current;
            if (isPreparing || !input) return;
            const range = { start: input.selectionStart, end: input.selectionEnd };
            // eslint-disable-next-line no-void -- prepareSessionReference reports its own failures through tryCommand
            void insertReference(candidate, range, input.value.slice(range.start, range.end));
        },
        highlight: (index: number) => setActive({ query: mention?.query, index }),
        chooseAt: (index: number) => chooseRow(rows.at(index)),
        /**
         * Returns whether the key was the list's, so the composer skips its own handling (Enter must not send the
         * half-typed `@word`).
         */
        didHandleKey: (event: AgentChatComposerKeyEvent): boolean => {
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
            if (!action || (action !== 'dismiss' && !activeRow)) return false;
            event.preventDefault();
            if (action === 'next' || action === 'previous') {
                setActive({
                    query: mention.query,
                    index: agentChatMentionStep(
                        activeIndex,
                        action === 'next' ? 1 : -1,
                        rows.length,
                    ),
                });
            } else if (action === 'dismiss') setDismissedDraft(draft);
            else chooseRow(activeRow);
            return true;
        },
    };
}

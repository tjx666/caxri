import type { ChangeEvent, KeyboardEvent, RefObject, SyntheticEvent } from 'react';
import { useEffect, useId, useState } from 'react';

import type { CommanderInboxItem } from '@caxri/protocol';

import {
    mentionAtCaret,
    suggestionMenuKeyAction,
    suggestionOptionId,
} from '../../../lib/suggestion-options';
import {
    inboxMentionCandidates,
    inboxMentionSuggestion,
    inboxReplyTarget,
    removeInboxMention,
} from '../commander-inbox';
import { replyToCommanderInboxItem } from '../commander-inbox-commands';
import {
    chooseCommanderInboxReplyTarget,
    useCommanderInboxUiStore,
} from '../commander-inbox-store';

/**
 * The Inbox reply box: free text, an `@` picker that chooses which item the reply answers, and Enter to send
 * (Shift+Enter for a new line). The picker lives here rather than in the Commander Terminal because Codex's own
 * composer already claims `@` for file search. It shares the Chat composer's `@` parsing, keys, and list: focus stays
 * in the textarea, which names the active row through `aria-activedescendant`.
 */
export function useCommanderInboxComposer(
    items: readonly CommanderInboxItem[],
    textareaReference: RefObject<HTMLTextAreaElement | null>,
) {
    const listId = useId();
    const [draft, setDraft] = useState('');
    const [caret, setCaret] = useState(0);
    const [highlight, setHighlight] = useState(0);
    const [isSending, setIsSending] = useState(false);
    /**
     * The `@` whose picker Escape closed; typing on keeps it closed until another `@` starts a new mention.
     */
    const [dismissedMentionStart, setDismissedMentionStart] = useState<number>();
    const targetId = useCommanderInboxUiStore((state) => state.targetId);
    const focusEpoch = useCommanderInboxUiStore((state) => state.focusEpoch);
    const target = inboxReplyTarget(items, targetId);
    const mention = mentionAtCaret(draft, caret);
    const candidates = mention ? inboxMentionCandidates(items, mention.query) : [];
    const isPickerOpen =
        mention !== undefined && mention.start !== dismissedMentionStart && candidates.length > 0;
    const activeIndex = Math.min(highlight, Math.max(candidates.length - 1, 0));
    const activeItem = isPickerOpen ? candidates[activeIndex] : undefined;
    const activeOptionId = activeItem
        ? suggestionOptionId(listId, inboxMentionSuggestion(activeItem).key)
        : undefined;
    /**
     * The rows never take focus, so the browser does not scroll the active one into view; arrowing past the list's
     * visible height has to ask for it, as the Chat composer's lists do.
     */
    useEffect(() => {
        if (!activeOptionId) return;
        document
            .querySelector(`#${CSS.escape(activeOptionId)}`)
            ?.scrollIntoView({ block: 'nearest' });
    }, [activeOptionId]);

    useEffect(() => {
        if (focusEpoch > 0) textareaReference.current?.focus();
    }, [focusEpoch, textareaReference]);

    function choose(item: CommanderInboxItem): void {
        if (!mention) return;
        const next = removeInboxMention(draft, mention);
        setDraft(next.text);
        setCaret(next.caret);
        setHighlight(0);
        chooseCommanderInboxReplyTarget(item.id);
        requestAnimationFrame(() =>
            textareaReference.current?.setSelectionRange(next.caret, next.caret),
        );
    }

    async function send(): Promise<void> {
        const body = draft.trim();
        if (!target || body === '' || isSending) return;
        setIsSending(true);
        let replied: Awaited<ReturnType<typeof replyToCommanderInboxItem>>;
        try {
            replied = await replyToCommanderInboxItem(target.id, body);
        } finally {
            setIsSending(false);
        }
        if (!replied) return;
        setDraft('');
        setCaret(0);
    }

    function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
        if (event.nativeEvent.isComposing) return;
        const action = activeItem ? suggestionMenuKeyAction(event) : undefined;
        if (activeItem && mention && action) {
            event.preventDefault();
            if (action === 'next' || action === 'previous') {
                const step = action === 'next' ? 1 : -1;
                setHighlight((activeIndex + step + candidates.length) % candidates.length);
            } else if (action === 'dismiss') setDismissedMentionStart(mention.start);
            // Tab and Enter both choose: an Inbox item has nothing to complete into the text.
            else choose(activeItem);
            return;
        }
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            // Fire-and-forget: the reply command reports its own failure through a toast.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void send();
        }
    }

    function onChange(event: ChangeEvent<HTMLTextAreaElement>): void {
        setDraft(event.target.value);
        setCaret(event.target.selectionStart);
        setHighlight(0);
    }

    return {
        activeIndex,
        candidates: isPickerOpen ? candidates : [],
        chooseAt: (index: number) => {
            const item = candidates.at(index);
            if (isPickerOpen && item) choose(item);
        },
        clearTarget: () => chooseCommanderInboxReplyTarget(undefined),
        draft,
        highlight: setHighlight,
        /**
         * Combobox attributes for the textarea while the picker is open.
         */
        inputAria: isPickerOpen
            ? {
                  'aria-activedescendant': activeOptionId,
                  'aria-autocomplete': 'list' as const,
                  'aria-controls': listId,
                  'aria-expanded': true,
              }
            : { 'aria-expanded': false },
        isSending,
        listId,
        onChange,
        onKeyDown,
        onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) =>
            setCaret(event.currentTarget.selectionStart),
        send,
        target,
    };
}

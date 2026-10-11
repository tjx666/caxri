import type { ChangeEvent, KeyboardEvent, RefObject, SyntheticEvent } from 'react';
import { useEffect, useState } from 'react';

import type { CommanderInboxItem } from '@caxri/protocol';

import {
    activeInboxMention,
    inboxMentionCandidates,
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
 * composer already claims `@` for file search.
 */
export function useCommanderInboxComposer(
    items: readonly CommanderInboxItem[],
    textareaReference: RefObject<HTMLTextAreaElement | null>,
) {
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
    const mention = activeInboxMention(draft, caret);
    const candidates = mention ? inboxMentionCandidates(items, mention.query) : [];
    const isPickerOpen =
        mention !== undefined && mention.start !== dismissedMentionStart && candidates.length > 0;

    useEffect(() => {
        if (focusEpoch > 0) textareaReference.current?.focus();
    }, [focusEpoch, textareaReference]);

    function choose(item: CommanderInboxItem): void {
        if (!mention) return;
        const next = removeInboxMention(draft, mention, caret);
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
        if (isPickerOpen) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setHighlight((highlight + step + candidates.length) % candidates.length);
                return;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                choose(candidates[Math.min(highlight, candidates.length - 1)]);
                return;
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                setDismissedMentionStart(mention.start);
                return;
            }
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
        candidates: isPickerOpen ? candidates : [],
        choose,
        clearTarget: () => chooseCommanderInboxReplyTarget(undefined),
        draft,
        highlight: Math.min(highlight, Math.max(candidates.length - 1, 0)),
        isSending,
        onChange,
        onKeyDown,
        onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) =>
            setCaret(event.currentTarget.selectionStart),
        send,
        target,
    };
}

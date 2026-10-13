import type { RefObject } from 'react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { Check, Copy, TextQuote } from 'lucide-react';

import type { CopyFeedbackStatus } from '../../components/copy-feedback';
import {
    COPY_FEEDBACK_RESET_MS,
    copyButtonLabel,
    writeToClipboardWithFeedback,
} from '../../components/copy-feedback';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { quoteAgentChatMessageFromMenu } from './agent-chat-message-menu-actions';
import { useAgentChatSelectionToolbar } from './hooks/use-agent-chat-selection-toolbar';

const BUTTON_CLASS_NAME =
    'flex h-6 cursor-pointer items-center gap-1.5 rounded border-0 bg-transparent px-2 text-[12px] text-foreground hover:bg-[var(--selection)] focus-visible:outline focus-visible:outline-accent';

/**
 * Copy and Add to message for text selected in a Chat transcript, floating over the selection instead of confirming a
 * copy in a corner toast. Copy writes the selected text, and confirms with a check in place. Add to message runs the
 * same quote a message's right-click menu does (`quoteAgentChatMessageFromMenu`): a Markdown block at the end of
 * `terminalId`'s draft (the parent Chat's for a subagent tab), the selection cleared, and that Chat's tab brought
 * forward; `onQuoted` then lets the Chat place the composer's caret. The toolbar keeps the selection alive by refusing
 * the press that would collapse it.
 */
export function AgentChatSelectionToolbar({
    contentReference,
    onQuoted,
    scrollReference,
    terminalId,
}: {
    contentReference: RefObject<HTMLElement | null>;
    onQuoted?: () => void;
    scrollReference: RefObject<HTMLElement | null>;
    terminalId: string;
}) {
    const { t } = useTranslation();
    const { dismiss, selection, toolbarReference } = useAgentChatSelectionToolbar(
        contentReference,
        scrollReference,
    );
    // Feedback belongs to the selection it copied, so a new selection starts back at Copy.
    const [copied, setCopied] = useState<{ selection: object; status: CopyFeedbackStatus }>();
    const copyStatus = copied && copied.selection === selection ? copied.status : 'idle';
    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(undefined), COPY_FEEDBACK_RESET_MS);
        return () => clearTimeout(timer);
    }, [copied]);
    if (!selection) return null;
    const copyLabel = copyButtonLabel(copyStatus, t('agentChat.timeline.copySelection'), t);
    const quote = (): void => {
        quoteAgentChatMessageFromMenu(terminalId, selection.text);
        dismiss();
        onQuoted?.();
    };
    return createPortal(
        <div
            aria-label={t('agentChat.timeline.selectionActions')}
            // Hidden until `useAgentChatSelectionToolbar` measures and places it; it then fades in on the overlay enter
            // timing, as a popover does, and leaves instantly so it never lingers over the text the user moves on to.
            className="motion-safe:animate-in motion-safe:fade-in-0 invisible fixed top-0 left-0 z-[80] flex items-center gap-0.5 rounded-md bg-elevated p-0.5 shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)] duration-(--motion-overlay-enter) ease-(--motion-ease-enter)"
            ref={toolbarReference}
            role="toolbar"
            onPointerDown={(event) => event.preventDefault()}
        >
            <button
                className={cn(BUTTON_CLASS_NAME, copyStatus === 'failed' && 'text-danger')}
                type="button"
                onClick={async () => {
                    const status = await writeToClipboardWithFeedback(
                        navigator.clipboard,
                        selection.text,
                    );
                    setCopied({ selection, status });
                }}
            >
                {copyStatus === 'copied' ? (
                    <Check className="size-3.5" />
                ) : (
                    <Copy className="size-3.5" />
                )}
                {copyLabel}
            </button>
            <button className={BUTTON_CLASS_NAME} type="button" onClick={quote}>
                <TextQuote className="size-3.5" />
                {t('agentChat.timeline.quoteSelection')}
            </button>
        </div>,
        document.body,
    );
}

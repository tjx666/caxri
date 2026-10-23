import type { RefObject } from 'react';
import { useEffect, useState } from 'react';

import { Check, Copy, TextQuote } from 'lucide-react';

import type { CopyFeedbackStatus } from '../../../components/copy-feedback';
import {
    COPY_FEEDBACK_RESET_MS,
    copyButtonLabel,
    writeToClipboardWithFeedback,
} from '../../../components/copy-feedback';
import {
    SELECTION_TOOLBAR_BUTTON_CLASS_NAME,
    SelectionToolbar,
} from '../../../components/selection-toolbar';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { useAgentChatSelectionToolbar } from '../hooks/use-agent-chat-selection-toolbar';
import { quoteAgentChatMessageFromMenu } from './agent-chat-message-menu-actions';

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
    return (
        <SelectionToolbar
            label={t('agentChat.timeline.selectionActions')}
            toolbarReference={toolbarReference}
        >
            <button
                className={cn(
                    SELECTION_TOOLBAR_BUTTON_CLASS_NAME,
                    copyStatus === 'failed' && 'text-danger',
                )}
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
            <button className={SELECTION_TOOLBAR_BUTTON_CLASS_NAME} type="button" onClick={quote}>
                <TextQuote className="size-3.5" />
                {t('agentChat.timeline.quoteSelection')}
            </button>
        </SelectionToolbar>
    );
}

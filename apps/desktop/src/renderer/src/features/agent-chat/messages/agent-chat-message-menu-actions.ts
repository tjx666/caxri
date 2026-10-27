import { translate } from '../../../i18n';
import { writeClipboardText } from '../../../lib/clipboard';
import { pushToast, tryCommand } from '../../../stores/toasts';
import { appendToAgentChatDraft } from '../composer-input/agent-chat-drafts';
import { revealAgentChat } from '../tasks/agent-chat-task-opener';
import { agentChatSelectionQuote } from './agent-chat-selection';

/**
 * The selected text when the document selection lies inside `container`, so a right-click on a highlighted phrase
 * copies that phrase and a right-click elsewhere in the message copies all of it.
 */
export function agentChatSelectionInside(container: HTMLElement | null): string {
    const selection = getSelection();
    if (!container || !selection || selection.isCollapsed) return '';
    const { anchorNode, focusNode } = selection;
    if (!anchorNode || !focusNode) return '';
    return container.contains(anchorNode) && container.contains(focusNode)
        ? selection.toString()
        : '';
}

/**
 * Copies from a message's right-click menu with the same confirmation a keyboard copy out of the transcript raises,
 * since a native menu entry, unlike the hover row's Copy button, has no check mark to turn into.
 */
export function copyAgentChatMessageFromMenu(value: string, isSelection: boolean): void {
    void tryCommand(translate('agentChat.userMenu.copyFailed'), async () => {
        await writeClipboardText(value);
        pushToast(
            'success',
            translate(
                isSelection
                    ? 'agentChat.userMenu.selectionCopied'
                    : 'agentChat.userMenu.messageCopied',
            ),
        );
    });
}

/**
 * Add to Message, from a message's right-click menu or the selection toolbar (the one implementation both use): quotes
 * `text` at the end of `terminalId`'s draft, clears the selection it came from, and brings the Chat's composer forward
 * to show it.
 */
export function quoteAgentChatMessageFromMenu(terminalId: string, text: string): void {
    // The blank line after the quote starts the user's own paragraph, so what they type next is not quoted.
    appendToAgentChatDraft(terminalId, `${agentChatSelectionQuote(text)}\n\n`);
    getSelection()?.removeAllRanges();
    revealAgentChat(terminalId);
}

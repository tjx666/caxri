import { pushToast } from '../../stores/toasts';

/**
 * Confirms a keyboard or Edit-menu copy out of a Chat transcript. The transcript is `select-none` except for the user's
 * and the Agent's message text, so a non-empty document selection here is always message text; the native copy itself
 * is left untouched and carries both the plain text and the rendered HTML. A copy inside a text field reports an empty
 * document selection, so typing in an answer box never raises the toast.
 */
export function announceAgentChatSelectionCopy(): void {
    if (!getSelection()?.toString().trim()) return;
    pushToast('success', 'Selection copied');
}

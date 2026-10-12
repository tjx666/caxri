import { translate } from '../../i18n';
import { pushToast } from '../../stores/toasts';

/**
 * Confirms a keyboard or Edit-menu copy out of a Chat transcript. The transcript is `select-none` except for its
 * content: the user's and the Agent's message text, notice text, reasoning, and code, command output, and diff bodies
 * (their gutters and headers stay chrome), so a non-empty document selection here is always transcript content; the
 * native copy itself is left untouched and carries both the plain text and the rendered HTML. A copy inside a text
 * field reports an empty document selection, so typing in an answer box never raises the toast.
 */
export function announceAgentChatSelectionCopy(): void {
    if (!getSelection()?.toString().trim()) return;
    pushToast('success', translate('agentChat.timeline.selectionCopied'));
}

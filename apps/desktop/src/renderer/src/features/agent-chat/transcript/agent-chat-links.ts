import { openExternalUrl } from '../../../lib/external-link';
import { pushToast } from '../../../stores/toasts';

/**
 * Opens a web link from the transcript, in a reply or the user's own message, in the default browser.
 */
export function openAgentChatLink(url: string): void {
    void openExternalUrl(url, (message) => pushToast('error', message));
}

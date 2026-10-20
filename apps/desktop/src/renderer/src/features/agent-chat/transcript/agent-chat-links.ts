import { openExternalUrl } from '../../../lib/external-link';
import { pushToast } from '../../../stores/toasts';

/**
 * Opens a web link from the transcript, in a reply or the user's own message, in the default browser.
 */
export function openAgentChatLink(url: string): void {
    // eslint-disable-next-line no-void -- openExternalUrl reports its own failures through the callback
    void openExternalUrl(url, (message) => pushToast('error', message));
}

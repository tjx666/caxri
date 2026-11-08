import type { ClaudeWindowState } from '@caxri/protocol';

import { translate } from '../../../i18n';
import { createSharedLocalState } from '../../../lib/local-storage';
import { subscribeCaxriQuery } from '../../../queries/client';
import { pushToast, tryCommand } from '../../../stores/toasts';
import { updateClaudeWindows } from './claude-windows-client';

const ANNOUNCED_STORAGE_KEY = 'caxri.claudeWindows.announcedAccounts';

/**
 * Upper bound on remembered account keys, so a machine that cycles through many Claude accounts never grows the entry
 * without limit. The oldest keys go first; forgetting one only means that account is told once more.
 */
const MAX_ANNOUNCED_ACCOUNTS = 16;

/**
 * Keeps only string entries, so a corrupt stored value reads as "nobody was told" instead of throwing at load.
 */
export function parseAnnouncedAccounts(stored: unknown): string[] {
    return Array.isArray(stored)
        ? stored.filter((key): key is string => typeof key === 'string')
        : [];
}

/**
 * Shared by every window of the profile (docs/client-local-data.md). Each window subscribes to the same status push, so
 * the record is re-read at the moment of announcing: the window that announces first writes the account, and the others
 * then see it as told instead of showing a second toast.
 */
const sharedAnnounced = createSharedLocalState(ANNOUNCED_STORAGE_KEY, parseAnnouncedAccounts);

/**
 * The account key to tell about the keeper, or undefined when there is nothing to say. Only the plan default needs a
 * notice: the keeper then sends requests to Claude on the user's behalf although they never turned it on. Someone who
 * chose either way already knows, and a keeper that is off sends nothing.
 */
export function claudeWindowsAccountToAnnounce(
    state: ClaudeWindowState | undefined,
    announced: readonly string[],
): string | undefined {
    const account = state?.account;
    if (!account?.keepRolling || !account.keepRollingIsDefault) return undefined;
    return announced.includes(account.key) ? undefined : account.key;
}

/**
 * Turns the keeper off for the account the notice was about. Server Core refuses the write when another Claude account
 * signed in since, and `tryCommand` reports that instead of switching off someone else's keeper.
 */
export async function turnOffClaudeWindows(accountKey: string): Promise<void> {
    await tryCommand(translate('settings.claudeWindows.saveFailed'), () =>
        updateClaudeWindows({ accountKey, keepRolling: false }),
    );
}

/**
 * Tells a Claude Pro user once, per account on this device, that Caxri keeps their 5-hour windows rolling by default.
 * The keeper is on for Pro without the user ever opening its setting, and it sends requests to Claude on its own,
 * including from a background job while Caxri is closed, so it must not stay something only README readers know about.
 *
 * The notice is held until dismissed and recorded in the notification center, and the account counts as told the moment
 * it is shown: the decision it asks for is still reachable from the center and from Settings afterwards. Subscribing
 * also keeps `claudeWindow.status` observed, so a `claudeWindow.changed` push refreshes it even while the Settings card
 * is closed.
 */
export function subscribeClaudeWindowsDefaultNotice(): () => void {
    return subscribeCaxriQuery('claudeWindow.status', { refresh: false }, (state) => {
        const announced = sharedAnnounced.read();
        const accountKey = claudeWindowsAccountToAnnounce(state, announced);
        if (!accountKey) return;
        sharedAnnounced.write([...announced, accountKey].slice(-MAX_ANNOUNCED_ACCOUNTS));
        pushToast('info', translate('settings.claudeWindows.defaultNotice'), {
            persist: true,
            dismissOnSuccess: true,
            action: { id: 'claudeWindows.turnOff', params: { accountKey } },
            secondaryAction: { id: 'settings.openClaudeWindows' },
        });
    });
}

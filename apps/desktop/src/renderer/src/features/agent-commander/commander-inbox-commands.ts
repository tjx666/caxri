import type { CommanderInboxItem } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { caxriQueryKey, queryClient } from '../../queries/client';
import { showConfirm } from '../../stores/confirmations';
import { pushToast, tryCommand } from '../../stores/toasts';
import { runCommanderInboxAction, setCommanderInboxDismissing } from './commander-inbox-store';

export const COMMANDER_INBOX_QUERY_PARAMETERS = {};

/**
 * Re-reads the Inbox after this window changed it; `commanderInbox.changed` does the same for changes made elsewhere,
 * such as a reply from the phone.
 */
export function invalidateCommanderInbox(): Promise<void> {
    return queryClient.invalidateQueries({
        queryKey: caxriQueryKey('commander.inbox.list', COMMANDER_INBOX_QUERY_PARAMETERS),
    });
}

/**
 * Sends one reply. Resolves the updated item once the Server stored it, or undefined after a failure toast, so the
 * composer clears only text that is safe.
 */
export function replyToCommanderInboxItem(
    itemId: string,
    body: string,
): Promise<CommanderInboxItem | undefined> {
    return tryCommand(
        translate('agentCommander.inboxCommands.replyFailed'),
        () => caxri.request('commander.inbox.reply', { id: itemId, body }),
        { refresh: invalidateCommanderInbox },
    );
}

/**
 * Sends one of the answer options the Commander offered, exactly as written, as the reply to its question: the same
 * request the composer sends for a typed answer.
 */
export async function answerCommanderInboxItem(
    item: CommanderInboxItem,
    option: string,
): Promise<void> {
    await runCommanderInboxAction(item.id, 'answer', () =>
        replyToCommanderInboxItem(item.id, option),
    );
}

/**
 * How long a dismissal waits for Undo before the request is sent. It matches the "Dismissed" toast lifetime, so the
 * Undo button and the window to use it end together.
 */
export const COMMANDER_INBOX_DISMISS_UNDO_MS = 4_000;

const pendingDismissals = new Map<string, { timer: ReturnType<typeof setTimeout> }>();
const flushListener = { isInstalled: false };

function sendDismissal(itemId: string): Promise<unknown> {
    return tryCommand(
        translate('agentCommander.inboxCommands.dismissFailed'),
        () => caxri.request('commander.inbox.dismiss', { id: itemId }),
        { refresh: invalidateCommanderInbox },
    );
}

async function commitDismissal(itemId: string): Promise<void> {
    const pending = pendingDismissals.get(itemId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingDismissals.delete(itemId);
    try {
        await sendDismissal(itemId);
    } finally {
        // Keep the card hidden until the request settled and the list re-read, so it does not flash back first. A
        // failed request leaves the item open, and its card returns beside the failure toast.
        setCommanderInboxDismissing(itemId, false);
    }
}

/**
 * Sends every dismissal still waiting for Undo. The window closing must not turn a dismissal the user already saw
 * confirmed into one the Commander never hears about.
 */
export function flushCommanderInboxDismissals(): void {
    for (const itemId of pendingDismissals.keys())
        // Fire-and-forget: the window may be going away, and tryCommand reports a failure while it still can.
        void commitDismissal(itemId);
}

/**
 * Whether Undo can still take back this dismissal, asked when the toast's button is clicked.
 */
export function commanderInboxUndoDismissUnavailableReason(itemId: string): string | undefined {
    return pendingDismissals.has(itemId)
        ? undefined
        : translate('agentCommander.inboxCommands.dismissUndoExpired');
}

/**
 * Takes a dismissal back before it was sent: the Commander never hears about it and the card returns in place.
 */
export function undoCommanderInboxDismissal(itemId: string): void {
    const pending = pendingDismissals.get(itemId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingDismissals.delete(itemId);
    setCommanderInboxDismissing(itemId, false);
}

/**
 * Dismisses without asking: the card leaves the list at once and a toast offers Undo. The request, which notifies the
 * Commander, is only sent when that window ends, because the Server has no way to restore a dismissed item.
 */
export function dismissCommanderInboxItem(item: CommanderInboxItem): void {
    if (pendingDismissals.has(item.id)) return;
    if (!flushListener.isInstalled) {
        flushListener.isInstalled = true;
        window.addEventListener('pagehide', flushCommanderInboxDismissals);
    }
    setCommanderInboxDismissing(item.id, true);
    pendingDismissals.set(item.id, {
        timer: setTimeout(() => {
            // Fire-and-forget: commitDismissal reports its own failure through a toast.
            void commitDismissal(item.id);
        }, COMMANDER_INBOX_DISMISS_UNDO_MS),
    });
    pushToast('info', translate('agentCommander.inboxCommands.dismissed'), {
        history: false,
        action: { id: 'agentCommander.undoDismiss', params: { itemId: item.id } },
    });
}

/**
 * Asks once, then merges pinned to the head the Commander verified and to the item revision on screen, so a report the
 * Commander replaced while the dialog was open is refused instead of merged.
 */
export async function mergeCommanderInboxItem(item: CommanderInboxItem): Promise<void> {
    const pullRequest = item.pullRequest;
    if (!pullRequest) return;
    const pullRequestName = `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`;
    const isConfirmed = await showConfirm({
        title: translate('agentCommander.inboxCommands.mergeTitle', {
            pullRequest: pullRequestName,
        }),
        message: translate('agentCommander.inboxCommands.mergeMessage', {
            sha: pullRequest.headSha.slice(0, 7),
        }),
        confirmLabel: translate('agentCommander.inbox.merge'),
    });
    if (!isConfirmed) return;
    // The merge waits on GitHub, so the card shows it pending from the confirmation until the reply.
    const result = await runCommanderInboxAction(item.id, 'merge', () =>
        tryCommand(
            translate('agentCommander.inboxCommands.mergeFailed'),
            () => caxri.request('commander.inbox.merge', { id: item.id, revision: item.revision }),
            { refresh: invalidateCommanderInbox },
        ),
    );
    if (result)
        pushToast(
            'success',
            translate('agentCommander.inboxCommands.merged', { pullRequest: pullRequestName }),
        );
}

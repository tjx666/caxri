import type { BotInboxItem } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { caxriQueryKey, queryClient } from '../../queries/client';
import { showConfirm } from '../../stores/confirmations';
import { pushToast, tryCommand } from '../../stores/toasts';
import { runBotInboxAction, setBotInboxDismissing } from './bot-inbox-store';

export const BOT_INBOX_QUERY_PARAMETERS = {};

/**
 * Re-reads the Inbox after this window changed it; `botInbox.changed` does the same for changes made elsewhere, such as
 * a reply from the phone.
 */
export function invalidateBotInbox(): Promise<void> {
    return queryClient.invalidateQueries({
        queryKey: caxriQueryKey('bot.inbox.list', BOT_INBOX_QUERY_PARAMETERS),
    });
}

/**
 * Sends one reply. Resolves the updated item once the Server stored it, or undefined after a failure toast, so the
 * composer clears only text that is safe.
 */
export function replyToBotInboxItem(
    itemId: string,
    body: string,
): Promise<BotInboxItem | undefined> {
    return tryCommand(
        translate('caxriBot.inboxCommands.replyFailed'),
        () => caxri.request('bot.inbox.reply', { id: itemId, body }),
        { refresh: invalidateBotInbox },
    );
}

/**
 * Sends one of the answer options Caxri Bot offered, exactly as written, as the reply to its question: the same request
 * the composer sends for a typed answer.
 */
export async function answerBotInboxItem(item: BotInboxItem, option: string): Promise<void> {
    await runBotInboxAction(item.id, 'answer', () => replyToBotInboxItem(item.id, option));
}

/**
 * How long a dismissal waits for Undo before the request is sent. It matches the "Dismissed" toast lifetime, so the
 * Undo button and the window to use it end together.
 */
export const BOT_INBOX_DISMISS_UNDO_MS = 4_000;

const pendingDismissals = new Map<string, { timer: ReturnType<typeof setTimeout> }>();
const flushListener = { isInstalled: false };

function sendDismissal(itemId: string): Promise<unknown> {
    return tryCommand(
        translate('caxriBot.inboxCommands.dismissFailed'),
        () => caxri.request('bot.inbox.dismiss', { id: itemId }),
        { refresh: invalidateBotInbox },
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
        setBotInboxDismissing(itemId, false);
    }
}

/**
 * Sends every dismissal still waiting for Undo. The window closing must not turn a dismissal the user already saw
 * confirmed into one Caxri Bot never hears about.
 */
export function flushBotInboxDismissals(): void {
    for (const itemId of pendingDismissals.keys())
        // Fire-and-forget: the window may be going away, and tryCommand reports a failure while it still can.
        void commitDismissal(itemId);
}

/**
 * Whether Undo can still take back this dismissal, asked when the toast's button is clicked.
 */
export function botInboxUndoDismissUnavailableReason(itemId: string): string | undefined {
    return pendingDismissals.has(itemId)
        ? undefined
        : translate('caxriBot.inboxCommands.dismissUndoExpired');
}

/**
 * Takes a dismissal back before it was sent: Caxri Bot never hears about it and the card returns in place.
 */
export function undoBotInboxDismissal(itemId: string): void {
    const pending = pendingDismissals.get(itemId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingDismissals.delete(itemId);
    setBotInboxDismissing(itemId, false);
}

/**
 * Dismisses without asking: the card leaves the list at once and a toast offers Undo. The request, which notifies the
 * Caxri Bot, is only sent when that window ends, because the Server has no way to restore a dismissed item.
 */
export function dismissBotInboxItem(item: BotInboxItem): void {
    if (pendingDismissals.has(item.id)) return;
    if (!flushListener.isInstalled) {
        flushListener.isInstalled = true;
        window.addEventListener('pagehide', flushBotInboxDismissals);
    }
    setBotInboxDismissing(item.id, true);
    pendingDismissals.set(item.id, {
        timer: setTimeout(() => {
            // Fire-and-forget: commitDismissal reports its own failure through a toast.
            void commitDismissal(item.id);
        }, BOT_INBOX_DISMISS_UNDO_MS),
    });
    pushToast('info', translate('caxriBot.inboxCommands.dismissed'), {
        history: false,
        action: { id: 'caxriBot.undoDismiss', params: { itemId: item.id } },
    });
}

/**
 * Asks once, then merges pinned to the head Caxri Bot verified and to the item revision on screen, so a report the
 * Caxri Bot replaced while the dialog was open is refused instead of merged.
 */
export async function mergeBotInboxItem(item: BotInboxItem): Promise<void> {
    const pullRequest = item.pullRequest;
    if (!pullRequest) return;
    const pullRequestName = `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`;
    const isConfirmed = await showConfirm({
        title: translate('caxriBot.inboxCommands.mergeTitle', {
            pullRequest: pullRequestName,
        }),
        message: translate('caxriBot.inboxCommands.mergeMessage', {
            sha: pullRequest.headSha.slice(0, 7),
        }),
        confirmLabel: translate('caxriBot.inbox.merge'),
    });
    if (!isConfirmed) return;
    // The merge waits on GitHub, so the card shows it pending from the confirmation until the reply.
    const result = await runBotInboxAction(item.id, 'merge', () =>
        tryCommand(
            translate('caxriBot.inboxCommands.mergeFailed'),
            () => caxri.request('bot.inbox.merge', { id: item.id, revision: item.revision }),
            { refresh: invalidateBotInbox },
        ),
    );
    if (result)
        pushToast(
            'success',
            translate('caxriBot.inboxCommands.merged', { pullRequest: pullRequestName }),
        );
}

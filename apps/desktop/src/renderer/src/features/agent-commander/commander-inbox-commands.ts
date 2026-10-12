import type { CommanderInboxItem } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { caxriQueryKey, queryClient } from '../../queries/client';
import { showConfirm } from '../../stores/confirmations';
import { pushToast, tryCommand } from '../../stores/toasts';
import { runCommanderInboxAction } from './commander-inbox-store';

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

export async function dismissCommanderInboxItem(item: CommanderInboxItem): Promise<void> {
    const isConfirmed = await showConfirm({
        title: translate('agentCommander.inboxCommands.dismissTitle'),
        message: translate(
            item.kind === 'merge'
                ? 'agentCommander.inboxCommands.dismissMergeMessage'
                : 'agentCommander.inboxCommands.dismissQuestionMessage',
        ),
        confirmLabel: translate('common.dismiss'),
    });
    if (!isConfirmed) return;
    await tryCommand(
        translate('agentCommander.inboxCommands.dismissFailed'),
        () => caxri.request('commander.inbox.dismiss', { id: item.id }),
        { refresh: invalidateCommanderInbox },
    );
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

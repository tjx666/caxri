import { translate } from '../../i18n';
import type { ConfirmRequest } from '../../stores/confirmations';

/**
 * The in-app question an "Edit from here" asks before it replaces more than one later turn, or `undefined` when it
 * sends without asking. One turn is the message's own turn, which the edit banner already names; replacing several is
 * easy to miss under that muted caption and cannot be taken back from the Chat, so it asks and points at Fork, which
 * keeps them. An edit that also reverts files asks in the native revert dialog instead, so it never stacks a second
 * question on the same send.
 */
export function agentChatReplaceTurnsConfirm({
    removedTurns,
    restoreFiles,
}: {
    removedTurns: number;
    restoreFiles: boolean;
}): ConfirmRequest | undefined {
    if (restoreFiles || removedTurns <= 1) return undefined;
    return {
        title: translate('agentChat.undo.replaceTurnsTitle', { count: removedTurns }),
        message: translate('agentChat.undo.replaceTurnsMessage', { count: removedTurns - 1 }),
        confirmLabel: translate('agentChat.undo.replaceTurnsConfirm'),
    };
}

/**
 * The success toast after "Restore code to here". Server Core restores from the provider's checkpoints and does not
 * report a file count, so the toast names the turns whose changes were put back.
 */
export function agentChatRestoreSuccessMessage(restoredTurns: number): string {
    return restoredTurns === 1
        ? translate('agentChat.undo.restoreSuccessOne')
        : translate('agentChat.undo.restoreSuccessOther', { count: restoredTurns });
}

/**
 * The success toast after "Fork from here", naming the new Session when the Workbench already lists it.
 */
export function agentChatForkSuccessMessage(sessionTitle: string | undefined): string {
    const title = sessionTitle?.trim();
    return title
        ? translate('agentChat.undo.forkSuccessNamed', { title })
        : translate('agentChat.undo.forkSuccess');
}

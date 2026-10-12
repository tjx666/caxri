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
        title: `Replace ${removedTurns} later turns?`,
        message: `Sending this edit removes this message's turn and the ${removedTurns - 1} after it from the conversation. To keep them, cancel and use Fork from Here instead.`,
        confirmLabel: 'Replace Turns',
    };
}

/**
 * The success toast after "Restore code to here". Server Core restores from the provider's checkpoints and does not
 * report a file count, so the toast names the turns whose changes were put back.
 */
export function agentChatRestoreSuccessMessage(restoredTurns: number): string {
    return restoredTurns === 1
        ? 'Restored the code changed in 1 turn'
        : `Restored the code changed in ${restoredTurns} turns`;
}

/**
 * The success toast after "Fork from here", naming the new Session when the Workbench already lists it.
 */
export function agentChatForkSuccessMessage(sessionTitle: string | undefined): string {
    const title = sessionTitle?.trim();
    return title ? `Forked into a new Session: ${title}` : 'Forked into a new Session';
}

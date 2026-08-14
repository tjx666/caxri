import { isCaxriError } from '@shared/ipc';

export type HeldMessageActionResult = 'confirmed' | 'rejected' | 'final-rejection';

/**
 * Non-retryable protocol failures mean the Host can no longer settle this held message. Retaining it
 * would leave an undismissable modal whose buttons can only repeat the same failure.
 */
export function heldMessageActionResultForError(error: unknown): HeldMessageActionResult {
    if (
        isCaxriError(error) &&
        ['NOT_FOUND', 'VALIDATION', 'FORBIDDEN', 'PATH_DENIED'].includes(error.code)
    )
        return 'final-rejection';
    return 'rejected';
}

/**
 * Retains a held message until Host confirms its transition. A rejected Desktop request can be a
 * transient transport failure, so removing it would leave the user unable to retry the decision.
 */
export function updateHeldMessagesAfterAction<T extends { messageId: string }>(
    messages: T[],
    messageId: string,
    result: HeldMessageActionResult,
): T[] {
    return result === 'confirmed' || result === 'final-rejection'
        ? messages.filter((message) => message.messageId !== messageId)
        : messages;
}

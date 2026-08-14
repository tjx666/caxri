export type HeldMessageActionResult = 'confirmed' | 'rejected';

/**
 * Retains a held message until Host confirms its transition. A rejected Desktop request can be a
 * transient transport failure, so removing it would leave the user unable to retry the decision.
 */
export function updateHeldMessagesAfterAction<T extends { messageId: string }>(
    messages: T[],
    messageId: string,
    result: HeldMessageActionResult,
): T[] {
    return result === 'confirmed'
        ? messages.filter((message) => message.messageId !== messageId)
        : messages;
}

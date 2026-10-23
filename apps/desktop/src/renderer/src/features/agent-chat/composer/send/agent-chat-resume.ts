import type { AgentChatSnapshot } from '@caxri/protocol';

/**
 * Whether the Chat's latest turn ended before it finished (the user or another Agent stopped it, the provider process
 * exited, or the provider reported a failure) and nothing has run since, so an empty composer's Send button can offer
 * to continue it. This follows the Codex app, which turns Send into Resume after an interrupted or failed turn; Caxri
 * sends a visible "Continue" message instead of an empty turn, because not every provider can start a turn without
 * input.
 */
export function isAgentChatTurnResumable(
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'turns'> | undefined,
): boolean {
    if (!snapshot || snapshot.activeTurnId !== undefined) return false;
    const status = snapshot.turns.at(-1)?.status;
    return status === 'interrupted' || status === 'failed';
}

/**
 * Whether the empty composer's Send button continues the stopped or failed turn ({@link isAgentChatTurnResumable})
 * instead of sending: the Chat accepts a message, nothing is typed, attached, or in flight, no queued message will run
 * by itself, and neither Goal mode nor "Edit from here" owns the draft.
 */
export function isAgentChatResumeOffered(state: {
    canSend: boolean;
    hasContent: boolean;
    hasQueue: boolean;
    isAttaching: boolean;
    isEditing: boolean;
    isGoalMode: boolean;
    isSending: boolean;
    snapshot: Parameters<typeof isAgentChatTurnResumable>[0];
}): boolean {
    if (!state.canSend || state.isSending || state.isAttaching || state.hasContent) return false;
    if (state.hasQueue || state.isGoalMode || state.isEditing) return false;
    return isAgentChatTurnResumable(state.snapshot);
}

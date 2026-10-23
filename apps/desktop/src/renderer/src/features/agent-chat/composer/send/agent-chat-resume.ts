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

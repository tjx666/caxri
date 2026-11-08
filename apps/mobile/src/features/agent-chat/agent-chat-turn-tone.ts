import type { AgentChatTurn } from '@caxri/protocol';

/**
 * The semantic tone of a finished turn's footer, as Desktop tones its fold row: a failed turn is `danger`, one that
 * stopped without the user asking `warning`, a failure the Chat will continue past on its own (a scheduled usage-limit
 * continuation) `muted`, and a completed turn or one the user stopped stays quiet.
 */
export function agentChatTurnTone(
    status: AgentChatTurn['status'],
    stoppedBy?: AgentChatTurn['stoppedBy'],
    isContinuationScheduled = false,
): 'danger' | 'muted' | 'warning' {
    if (status === 'failed') return isContinuationScheduled ? 'muted' : 'danger';
    return status === 'interrupted' && stoppedBy !== 'user' ? 'warning' : 'muted';
}

import type { AgentChatTurn } from '@caxri/protocol';

import type { ChatLifecycleEvent } from './chat-provider';

/**
 * All providers preserve turn ownership and maintenance classification through success, interruption, and failure.
 */
export function finishedChatLifecycle(
    status: AgentChatTurn['status'],
    details: Omit<ChatLifecycleEvent, 'phase' | 'agentFailure'>,
): ChatLifecycleEvent {
    return {
        ...details,
        phase: status === 'failed' ? 'turnFailed' : 'turnFinished',
        ...(status === 'failed' && { agentFailure: 'provider_failed' }),
    };
}

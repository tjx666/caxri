import { randomUUID } from 'node:crypto';

import type { AgentChatMessageInput } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { AgentChatProviderSession } from './chat-provider';
import type { ChatState } from './chat-states';

export async function deliverChatMessage(
    session: AgentChatProviderSession,
    state: Pick<ChatState, 'followUps' | 'projection'>,
    message: Omit<AgentChatMessageInput, 'delivery'>,
    delivery: 'queue' | 'steer',
): Promise<void> {
    /**
     * A compact RPC can be accepted before it reports a turn id. Explicit steering must fail in that gap too, instead
     * of silently becoming a queued message for a different turn.
     */
    if (delivery === 'steer' && state.projection.snapshot.operation === 'compacting')
        throw new CaxriError(
            'CONFLICT',
            'Cannot steer a Chat while context compaction is in progress',
        );
    if (delivery === 'steer' && state.projection.snapshot.activeTurnId) {
        await session.send(message, { delivery: 'steered' });
        state.followUps.logSteered();
        return;
    }
    if (state.followUps.mustWait()) {
        state.followUps.add({ id: randomUUID(), kind: 'message', message });
        return;
    }
    await session.send(message);
}

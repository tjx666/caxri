import type { AgentChatPatchOperation } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { GrokUpdates } from '../grok-updates';

function text(value: string) {
    return { content: { type: 'text', text: value } };
}

describe('GrokUpdates replay', () => {
    it('dates replayed items by the frame that first created them', () => {
        const updates = new GrokUpdates({
            apply: () => {},
            activeTurnId: () => {},
            onInteractionResolved: () => {},
        });
        updates.beginReplay();
        updates.setEventTime(1_000);
        updates.onSessionUpdate({ sessionUpdate: 'user_message_chunk', ...text('hello') });
        updates.setEventTime(2_000);
        updates.onSessionUpdate({ sessionUpdate: 'agent_message_chunk', ...text('Hi ') });
        updates.setEventTime(3_000);
        updates.onSessionUpdate({ sessionUpdate: 'agent_message_chunk', ...text('there') });
        // A frame without a time leaves its item undated rather than guessed.
        updates.setEventTime(undefined);
        updates.onSessionUpdate({ sessionUpdate: 'agent_thought_chunk', ...text('hmm') });
        const operations: AgentChatPatchOperation[] = updates.endReplay(true);
        const items = operations.flatMap((operation) =>
            operation.op === 'upsertItem' ? [operation.item] : [],
        );
        expect(items.map((item) => [item.type, item.createdAt])).toEqual([
            ['userMessage', 1_000],
            ['agentMessage', 2_000],
            ['reasoning', undefined],
        ]);
    });
});

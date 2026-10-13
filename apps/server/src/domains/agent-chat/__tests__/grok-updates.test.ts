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

    it('reads a merged replay frame for a rejected call as declined and a broken one as failed', () => {
        const updates = new GrokUpdates({
            apply: () => {},
            activeTurnId: () => {},
            onInteractionResolved: () => {},
        });
        updates.beginReplay();
        /**
         * Grok Build 1.0.50 replays each tool call as one `tool_call` frame with its final status, no updates.
         */
        const replayedCall = (toolCallId: string, output: string) =>
            updates.onSessionUpdate({
                sessionUpdate: 'tool_call',
                toolCallId,
                title: 'Execute `npm test`',
                kind: 'execute',
                status: 'failed',
                rawInput: { command: 'npm test' },
                content: [{ type: 'content', ...text(output) }],
                _meta: { 'x.ai/tool': { name: 'run_terminal_command' } },
            });
        updates.onSessionUpdate({ sessionUpdate: 'user_message_chunk', ...text('run it') });
        replayedCall(
            'call-rejected',
            'User rejected the execution for tool `run_terminal_command`',
        );
        replayedCall('call-broken', 'npm: command not found');
        const items = updates
            .endReplay(true)
            .flatMap((operation) => (operation.op === 'upsertItem' ? [operation.item] : []));
        expect(items.find((item) => item.id === 'call-rejected')).toMatchObject({
            type: 'command',
            status: 'declined',
        });
        expect(items.find((item) => item.id === 'call-broken')).toMatchObject({
            type: 'command',
            status: 'failed',
        });
    });
});

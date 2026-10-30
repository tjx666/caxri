import type { AgentChatPatchOperation } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { grokDisplayText, grokToolPresentation } from '../../grok/items';
import { applyGrokExtensionUpdate } from '../../grok/updates';
import { AcpUpdates } from '../updates';

/**
 * The updates of a Grok Build Chat that applies nothing live, for replay assertions.
 */
function grokUpdates() {
    return new AcpUpdates({
        apply: () => {},
        activeTurnId: () => {},
        presentation: grokToolPresentation,
        displayText: grokDisplayText,
    });
}

function text(value: string) {
    return { content: { type: 'text', text: value } };
}

describe('AcpUpdates replay for Grok Build', () => {
    it('dates replayed items by the frame that first created them', () => {
        const updates = grokUpdates();
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
        const updates = grokUpdates();
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

    it('replays an interjection as a steered message inside its turn and marks a queued prompt', () => {
        const updates = grokUpdates();
        updates.beginReplay();
        updates.onSessionUpdate({ sessionUpdate: 'user_message_chunk', ...text('first') });
        updates.onSessionUpdate({ sessionUpdate: 'agent_message_chunk', ...text('Working. ') });
        // Grok Build 1.0.62 wraps the interjection for the model and keeps what the user typed in `displayText`.
        updates.onSessionUpdate({
            sessionUpdate: 'user_message_chunk',
            content: {
                type: 'text',
                text: 'The user sent a message: also this',
                _meta: { displayText: 'also this' },
            },
        });
        updates.onSessionUpdate({ sessionUpdate: 'agent_message_chunk', ...text('Done.') });
        applyGrokExtensionUpdate(
            updates,
            {
                sessionUpdate: 'turn_completed',
                prompt_id: '6b1d3a52-1c5e-4f7e-9d0a-2f6c0a1b2c3d',
                stop_reason: 'end_turn',
            },
            () => {},
        );
        updates.onSessionUpdate({ sessionUpdate: 'user_message_chunk', ...text('second') });
        applyGrokExtensionUpdate(
            updates,
            {
                sessionUpdate: 'turn_completed',
                prompt_id: '6b1d3a52-1c5e-8c01-9d0a-2f6c0a1b2c3d',
                stop_reason: 'end_turn',
            },
            () => {},
        );
        const operations = updates.endReplay(true);
        const items = operations.flatMap((operation) =>
            operation.op === 'upsertItem' ? [operation.item] : [],
        );
        const turns = operations.flatMap((operation) =>
            operation.op === 'state' ? (operation.state.turns ?? []) : [],
        );
        expect(turns).toHaveLength(2);
        expect(
            items
                .filter((item) => item.type === 'userMessage')
                .map((item) => [item.text, item.delivery, item.turnId]),
        ).toEqual([
            ['first', undefined, turns[0].id],
            ['also this', 'steered', turns[0].id],
            ['second', 'queued', turns[1].id],
        ]);
    });
});

/**
 * The fake Claude Code CLI's default reply: thinking, a task list, and streamed text.
 */
import crypto from 'node:crypto';

import type { FakeClaudeIo } from './fake-claude-io.ts';

/**
 * Streams thinking, a `TodoWrite` plan, and `Hello from fake Claude. <reply>`, leaving the turn's result to the caller.
 */
export async function streamPlannedReply(io: FakeClaudeIo, reply: string) {
    const thinkingId = `msg_${crypto.randomUUID()}`;
    io.send(
        io.frame({
            type: 'stream_event',
            event: { type: 'message_start', message: { id: thinkingId } },
        }),
    );
    io.send(
        io.frame({
            type: 'stream_event',
            event: {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'thinking', thinking: '' },
            },
        }),
    );
    io.send(
        io.frame({
            type: 'stream_event',
            event: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: 'Considering the request.' },
            },
        }),
    );
    io.assistant(thinkingId, {
        type: 'thinking',
        thinking: 'Considering the request.',
        signature: 'fake',
    });
    io.assistant(thinkingId, {
        type: 'tool_use',
        id: `toolu_${crypto.randomUUID()}`,
        name: 'TodoWrite',
        input: {
            todos: [
                { content: 'Read the message', status: 'completed', activeForm: 'Reading' },
                { content: 'Reply', status: 'in_progress', activeForm: 'Replying' },
            ],
        },
    });
    await io.didStreamFully(`Hello from fake Claude. ${reply}`, 5);
}

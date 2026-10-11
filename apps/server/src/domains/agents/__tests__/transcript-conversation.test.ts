import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readTranscriptConversation } from '../transcript-conversation';
import type { AgentTranscriptLocation } from '../transcript-security';

function grokChunk(kind: 'agent_message_chunk' | 'user_message_chunk', text: string): string {
    return JSON.stringify({
        method: 'session/update',
        params: { update: { sessionUpdate: kind, content: { type: 'text', text } } },
    });
}

function codexMessage(role: 'assistant' | 'user', text: string): string {
    return JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role, content: [{ type: 'output_text', text }] },
    });
}

describe('readTranscriptConversation', () => {
    let home: string;
    let location: AgentTranscriptLocation;

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'caxri-transcript-conversation-'));
        const baseRoot = join(home, 'sessions');
        const root = join(baseRoot, 'project');
        await mkdir(root, { recursive: true });
        location = { baseRoot, root, path: join(root, 'transcript.jsonl') };
    });

    afterEach(async () => {
        await rm(home, { force: true, recursive: true });
    });

    it('joins streamed chunks verbatim and a tool call ends the run', async () => {
        await writeFile(
            location.path,
            [
                grokChunk('user_message_chunk', 'Rename the '),
                grokChunk('user_message_chunk', 'button'),
                grokChunk('agent_message_chunk', 'Done'),
                grokChunk('agent_message_chunk', ' renaming.'),
                JSON.stringify({ method: 'session/update', params: { update: {} } }),
                grokChunk('agent_message_chunk', 'Anything else?'),
                '',
            ].join('\n'),
        );
        const conversation = await readTranscriptConversation(location, 10_000);
        expect(conversation.messages).toEqual([
            { role: 'user', text: 'Rename the button' },
            { role: 'assistant', text: 'Done renaming.\n\nAnything else?' },
        ]);
    });

    it('keeps the most recent turns once the retained text exceeds the budget', async () => {
        const lines = Array.from({ length: 6 }, (_, index) =>
            codexMessage(index % 2 === 0 ? 'user' : 'assistant', `turn ${index} ${'y'.repeat(40)}`),
        );
        await writeFile(location.path, `${lines.join('\n')}\n`);
        const conversation = await readTranscriptConversation(location, 120);
        expect(conversation.omittedMessageCount).toBe(4);
        expect(conversation.messages.map((message) => message.text.slice(0, 6))).toEqual([
            'turn 4',
            'turn 5',
        ]);
    });

    it('reads a final record that lacks a trailing newline exactly once', async () => {
        await writeFile(
            location.path,
            `${codexMessage('user', 'first')}\n${codexMessage('assistant', 'last')}`,
        );
        const conversation = await readTranscriptConversation(location, 10_000);
        expect(conversation.messages).toEqual([
            { role: 'user', text: 'first' },
            { role: 'assistant', text: 'last' },
        ]);
    });

    it('reads only the tail of a transcript longer than the read window, starting at a whole record', async () => {
        const lines = Array.from({ length: 8 }, (_, index) =>
            codexMessage(index % 2 === 0 ? 'user' : 'assistant', `turn ${index}`),
        );
        await writeFile(location.path, `${lines.join('\n')}\n`);
        // The window starts inside the sixth record, so the read begins at the seventh.
        const tailWindowBytes = lines.slice(5).join('\n').length;
        const conversation = await readTranscriptConversation(location, 10_000, {
            tailWindowBytes,
        });
        expect(conversation.isTailOnly).toBe(true);
        expect(conversation.messages).toEqual([
            { role: 'user', text: 'turn 6' },
            { role: 'assistant', text: 'turn 7' },
        ]);
        const whole = await readTranscriptConversation(location, 10_000);
        expect(whole.isTailOnly).toBe(false);
        expect(whole.messages).toHaveLength(8);
    });
});

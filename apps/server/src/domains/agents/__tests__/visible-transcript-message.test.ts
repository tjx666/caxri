import { describe, expect, it } from 'vitest';

import { extractVisibleTranscriptMessage } from '../visible-transcript-message';

const chunk = (sessionUpdate: string, text: string) => ({
    method: 'session/update',
    params: { update: { sessionUpdate, content: { type: 'text', text } } },
});

describe('visible transcript messages', () => {
    it('keeps searchable text beyond the title excerpt for Claude and Codex', () => {
        const text = `${'a'.repeat(2000)} searchable ending`;
        expect(
            extractVisibleTranscriptMessage({
                type: 'assistant',
                message: { content: [{ type: 'text', text }] },
            })?.text,
        ).toBe(text);
        expect(
            extractVisibleTranscriptMessage({
                type: 'response_item',
                payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
            })?.text,
        ).toBe(text);
    });

    it('preserves Grok chunk spaces and excludes tool and control events', () => {
        expect(extractVisibleTranscriptMessage(chunk('agent_message_chunk', ' next'))).toEqual({
            role: 'assistant',
            text: ' next',
            isChunk: true,
        });
        expect(extractVisibleTranscriptMessage(chunk('user_message_chunk', 'question'))?.role).toBe(
            'user',
        );
        expect(
            extractVisibleTranscriptMessage(chunk('tool_call', 'private tool text')),
        ).toBeUndefined();
        expect(
            extractVisibleTranscriptMessage({
                ...chunk('agent_message_chunk', 'control'),
                method: '_x.ai/session/update',
            }),
        ).toBeUndefined();
    });

    it('excludes tools, reasoning, injected instructions and duplicate Codex events', () => {
        for (const record of [
            {
                type: 'user',
                message: { content: [{ type: 'tool_result', content: 'tool secret' }] },
            },
            {
                type: 'assistant',
                message: { content: [{ type: 'thinking', text: 'hidden reasoning' }] },
            },
            {
                type: 'user',
                message: { content: '  <environment_context>synthetic</environment_context>' },
            },
            { type: 'event_msg', payload: { type: 'user_message', message: 'duplicate' } },
            { type: 'assistant', isSidechain: true, message: { content: 'child text' } },
        ])
            expect(extractVisibleTranscriptMessage(record)).toBeUndefined();
    });
});

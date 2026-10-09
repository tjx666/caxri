import { describe, expect, it } from 'vitest';

import { closeDanglingItem, codexRequestKey, mapCodexItem, mapCodexRequest } from '../codex-items';

describe('Codex item mapping', () => {
    it('maps conversation and tool items into bounded Chat items', () => {
        expect(
            mapCodexItem(
                {
                    type: 'userMessage',
                    id: 'u',
                    content: [{ type: 'text', text: 'hi', text_elements: [] }],
                },
                't',
                false,
            ),
        ).toEqual({ id: 'u', turnId: 't', type: 'userMessage', text: 'hi' });
        expect(
            mapCodexItem(
                {
                    type: 'commandExecution',
                    id: 'c',
                    command: 'ls',
                    status: 'inProgress',
                    aggregatedOutput: null,
                    exitCode: null,
                },
                't',
                true,
            ),
        ).toEqual({
            id: 'c',
            turnId: 't',
            type: 'command',
            command: 'ls',
            status: 'running',
            output: '',
        });
        expect(
            mapCodexItem(
                {
                    type: 'fileChange',
                    id: 'f',
                    status: 'completed',
                    changes: [
                        { path: 'a.ts', kind: { type: 'update', move_path: null }, diff: '@@' },
                    ],
                },
                undefined,
                false,
            ),
        ).toEqual({
            id: 'f',
            type: 'fileChange',
            status: 'completed',
            changes: [{ path: 'a.ts', kind: 'update', diff: '@@' }],
        });
        expect(
            mapCodexItem(
                {
                    type: 'mcpToolCall',
                    id: 'm',
                    server: 'docs',
                    tool: 'search',
                    status: 'failed',
                    arguments: { q: 'x' },
                    error: { message: 'boom' },
                },
                't',
                false,
            ),
        ).toMatchObject({
            type: 'toolCall',
            name: 'docs/search',
            summary: '{"q":"x"}',
            output: 'boom',
        });
    });

    it('skips items that are not conversation content and malformed input', () => {
        expect(mapCodexItem({ type: 'plan', id: 'p', text: 'x' }, 't', false)).toBeUndefined();
        expect(mapCodexItem({ type: 'agentMessage' }, 't', false)).toBeUndefined();
        expect(mapCodexItem('nope', 't', false)).toBeUndefined();
    });

    it('closes items a turn left open', () => {
        expect(
            closeDanglingItem({
                id: 'c',
                type: 'command',
                command: 'x',
                status: 'running',
                output: '',
            }),
        ).toMatchObject({ status: 'interrupted' });
        expect(
            closeDanglingItem({ id: 'a', type: 'agentMessage', text: 'x', streaming: true }),
        ).toMatchObject({ streaming: false });
        expect(
            closeDanglingItem({
                id: 'c',
                type: 'command',
                command: 'x',
                status: 'completed',
                output: '',
            }),
        ).toBeUndefined();
    });

    it('keys a request by its approval callback before its item', () => {
        expect(codexRequestKey({ itemId: 'item', approvalId: 'approval' })).toBe('approval');
        expect(codexRequestKey({ itemId: 'item', approvalId: null })).toBe('item');
        expect(codexRequestKey({})).toBeUndefined();
    });

    it('maps questions with their options', () => {
        expect(
            mapCodexRequest('question', 'q', {
                questions: [
                    {
                        id: 'color',
                        header: 'Color',
                        question: 'Which?',
                        isOther: true,
                        options: [{ label: 'Red', description: 'Warm' }],
                    },
                    { header: 'missing id' },
                ],
            }),
        ).toEqual({
            id: 'q',
            kind: 'question',
            questions: [
                {
                    id: 'color',
                    header: 'Color',
                    question: 'Which?',
                    options: [{ label: 'Red', description: 'Warm' }],
                    allowsOther: true,
                },
            ],
        });
    });
});

import { MAX_AGENT_CHAT_DIFF_LENGTH, MAX_AGENT_CHAT_FILE_CHANGE_DIFF_TOTAL } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    answeredNotice,
    closeDanglingItem,
    codexRequestKey,
    mapCodexItem,
    mapCodexRequest,
} from '../codex-items';

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

    it('keeps the approval context Codex sends and only the decisions Caxri can offer', () => {
        expect(
            mapCodexRequest('command', 'r', {
                itemId: 'cmd-1',
                reason: 'Needs the network',
                command: 'curl example.com',
                cwd: '/work',
                networkApprovalContext: { host: 'example.com', protocol: 'https' },
                availableDecisions: [
                    'accept',
                    'decline',
                    'accept',
                    { acceptWithExecpolicyAmendment: { execpolicy_amendment: [] } },
                ],
            }),
        ).toEqual({
            id: 'r',
            kind: 'command',
            itemId: 'cmd-1',
            reason: 'Needs the network',
            command: 'curl example.com',
            cwd: '/work',
            networkHost: 'example.com',
            decisions: ['accept', 'decline'],
        });
        // No list, or a list with nothing Caxri can offer, means every plain decision applies.
        expect(mapCodexRequest('fileChange', 'f', { availableDecisions: [{ other: 1 }] })).toEqual({
            id: 'f',
            kind: 'fileChange',
        });
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

    it('records the answers to a question, labelled by header, and skips unanswered questions', () => {
        const question = (id: string, header: string) => ({
            id,
            header,
            question: `${id}?`,
            options: [],
            allowsOther: true,
        });
        expect(
            answeredNotice(
                {
                    id: 'q',
                    kind: 'question',
                    questions: [
                        question('color', 'Color'),
                        question('size', ''),
                        question('skip', ''),
                    ],
                },
                'turn-1',
                { color: ['Blue'], size: ['S', 'M'] },
            ),
        ).toEqual({
            id: 'answer:q',
            turnId: 'turn-1',
            type: 'notice',
            kind: 'answered',
            message: 'Color: Blue\nsize?: S, M',
        });
        expect(answeredNotice({ id: 'a', kind: 'fileChange' }, undefined, {})).toBeUndefined();
        expect(
            answeredNotice(
                { id: 'q', kind: 'question', questions: [question('x', 'X')] },
                undefined,
                {},
            ),
        ).toBeUndefined();
    });

    it("bounds the sum of one file-change item's diffs", () => {
        const count =
            Math.ceil(MAX_AGENT_CHAT_FILE_CHANGE_DIFF_TOTAL / MAX_AGENT_CHAT_DIFF_LENGTH) + 3;
        const item = mapCodexItem(
            {
                id: 'patch',
                type: 'fileChange',
                status: 'completed',
                changes: Array.from({ length: count }, (_, index) => ({
                    path: `file-${index}.ts`,
                    kind: { type: 'update' },
                    diff: 'd'.repeat(MAX_AGENT_CHAT_DIFF_LENGTH),
                })),
            },
            'turn',
            false,
        );
        if (item?.type !== 'fileChange') throw new Error('expected a file-change item');
        const total = item.changes.reduce((sum, change) => sum + change.diff.length, 0);
        expect(total).toBe(MAX_AGENT_CHAT_FILE_CHANGE_DIFF_TOTAL);
        // Every path is still listed, so the user sees what changed even when a diff is cut.
        expect(item.changes).toHaveLength(count);
        expect(item.changes.at(-1)?.diff).toBe('');
        // The cut is marked wherever it lands, so the pane never presents a partial patch as the whole change.
        expect(item.changes.at(0)?.truncated).toBeUndefined();
        expect(item.changes.at(-1)?.truncated).toBe(true);
    });

    it('marks a single oversized diff as truncated and leaves a whole one unmarked', () => {
        const item = mapCodexItem(
            {
                id: 'patch',
                type: 'fileChange',
                status: 'completed',
                changes: [
                    {
                        path: 'big.ts',
                        kind: { type: 'update', move_path: null },
                        diff: 'd'.repeat(MAX_AGENT_CHAT_DIFF_LENGTH + 1),
                    },
                    {
                        path: 'small.ts',
                        kind: { type: 'add' },
                        diff: 'one line\n',
                    },
                ],
            },
            'turn',
            false,
        );
        if (item?.type !== 'fileChange') throw new Error('expected a file-change item');
        expect(item.changes).toEqual([
            {
                path: 'big.ts',
                kind: 'update',
                diff: 'd'.repeat(MAX_AGENT_CHAT_DIFF_LENGTH),
                truncated: true,
            },
            { path: 'small.ts', kind: 'add', diff: 'one line\n' },
        ]);
    });
});

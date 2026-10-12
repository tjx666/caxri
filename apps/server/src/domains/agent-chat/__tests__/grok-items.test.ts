import { MAX_AGENT_CHAT_DIFF_LENGTH } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    grokCommands,
    grokModelState,
    grokPermissionOutcome,
    mapGrokPermission,
    mapGrokToolCall,
    mergeGrokToolCall,
} from '../grok-items';

const PERMISSION_OPTIONS = [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'always-allow', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
];

function call(update: Record<string, unknown>) {
    const merged = mergeGrokToolCall(undefined, { toolCallId: 'call-1', ...update });
    if (!merged) throw new Error('Expected a tool call');
    return merged;
}

describe('mergeGrokToolCall', () => {
    it('keeps earlier fields an update leaves out and replaces the ones it carries', () => {
        const first = call({
            title: 'Bash',
            kind: 'other',
            status: 'pending',
            rawInput: { command: 'ls' },
        });
        const merged = mergeGrokToolCall(first, {
            toolCallId: 'call-1',
            kind: 'execute',
            status: 'in_progress',
        });
        expect(merged).toEqual({
            id: 'call-1',
            title: 'Bash',
            kind: 'execute',
            status: 'in_progress',
            rawInput: { command: 'ls' },
            content: [],
        });
        expect(mergeGrokToolCall(first, { status: 'completed' })).toBeUndefined();
    });
});

describe('mapGrokToolCall', () => {
    it('reads a shell command from the title when the raw input lacks it', () => {
        expect(
            mapGrokToolCall(call({ kind: 'execute', title: 'Execute `git status`' }), 't1', false),
        ).toMatchObject({
            type: 'command',
            command: 'git status',
            status: 'running',
            turnId: 't1',
        });
    });

    it('marks a new file as added and a truncated diff as truncated', () => {
        const item = mapGrokToolCall(
            call({
                kind: 'edit',
                status: 'completed',
                content: [
                    { type: 'diff', path: '/repo/new.ts', newText: 'export {};\n' },
                    {
                        type: 'diff',
                        path: '/repo/big.ts',
                        oldText: '',
                        newText: 'x'.repeat(MAX_AGENT_CHAT_DIFF_LENGTH),
                    },
                ],
            }),
            undefined,
            false,
        );
        expect(
            item.type === 'fileChange' &&
                item.changes.map(({ path, kind, truncated }) => ({ path, kind, truncated })),
        ).toEqual([
            { path: '/repo/new.ts', kind: 'add', truncated: undefined },
            { path: '/repo/big.ts', kind: 'update', truncated: true },
        ]);
    });

    it('shows any other tool by its title with a one-line subject', () => {
        expect(
            mapGrokToolCall(
                call({
                    kind: 'fetch',
                    title: 'WebFetch',
                    status: 'failed',
                    rawInput: { url: 'https://example.com' },
                    content: [{ type: 'content', content: { type: 'text', text: 'timed out' } }],
                }),
                undefined,
                false,
            ),
        ).toMatchObject({
            type: 'toolCall',
            name: 'WebFetch',
            status: 'failed',
            summary: 'https://example.com',
            output: 'timed out',
        });
    });

    it('reads a replayed rejection as declined and any other failure as failed', () => {
        const failed = (text: string) =>
            mapGrokToolCall(
                call({
                    kind: 'execute',
                    title: 'Execute `rm ./marker`',
                    status: 'failed',
                    rawInput: { command: 'rm ./marker' },
                    content: [{ type: 'content', content: { type: 'text', text } }],
                }),
                undefined,
                false,
            );
        expect(failed('User rejected the execution for tool `run_terminal_command`')).toMatchObject(
            { type: 'command', status: 'declined' },
        );
        expect(failed('rm: ./marker: Permission denied')).toMatchObject({
            type: 'command',
            status: 'failed',
        });
    });
});

describe('Grok Build permissions', () => {
    it('offers the decisions the request has options for', () => {
        expect(
            mapGrokPermission(
                call({
                    kind: 'fetch',
                    title: 'WebFetch',
                    rawInput: { url: 'https://example.com' },
                }),
                [PERMISSION_OPTIONS[0], PERMISSION_OPTIONS[2]],
            ),
        ).toEqual({
            id: 'call-1',
            itemId: 'call-1',
            decisions: ['accept', 'decline'],
            kind: 'tool',
            name: 'WebFetch',
            summary: 'https://example.com',
        });
    });

    it('answers with the matching option, or cancelled when none matches', () => {
        expect(grokPermissionOutcome(PERMISSION_OPTIONS, 'acceptForSession')).toEqual({
            outcome: { outcome: 'selected', optionId: 'always-allow' },
        });
        expect(grokPermissionOutcome([PERMISSION_OPTIONS[0]], 'decline')).toEqual({
            outcome: { outcome: 'cancelled' },
        });
        expect(grokPermissionOutcome(PERMISSION_OPTIONS, 'cancel')).toEqual({
            outcome: { outcome: 'cancelled' },
        });
    });
});

describe('grokCommands', () => {
    it('keeps valid, distinct commands with their argument hint', () => {
        expect(
            grokCommands([
                { name: '/compact', description: 'Compress', input: null },
                { name: 'review', input: { hint: '<target>' } },
                { name: 'review', description: 'Duplicate' },
                { name: 'bad name' },
            ]),
        ).toEqual([
            { name: 'compact', description: 'Compress' },
            { name: 'review', argumentHint: '<target>' },
        ]);
    });
});

describe('grokModelState', () => {
    it('reads the current model and its context window', () => {
        expect(
            grokModelState({
                currentModelId: 'grok-a',
                availableModels: [{ modelId: 'grok-a', _meta: { totalContextTokens: 256000 } }],
            }),
        ).toEqual({ model: 'grok-a', contextWindow: 256000 });
        expect(grokModelState(undefined)).toEqual({});
    });
});

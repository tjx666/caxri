import { describe, expect, it } from 'vitest';

import { mapAcpPermission, mapAcpToolCall, mergeAcpToolCall } from '../../acp/items';
import { AcpUpdates } from '../../acp/updates';
import {
    antigravityConfigState,
    antigravityModels,
    antigravityToolPresentation,
    antigravityUsage,
} from '../items';

/**
 * The `configOptions` shape `agy acp` 1.4.11 returns from `session/new`.
 */
const CONFIG_OPTIONS = [
    {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'gemini-fake-flash',
        options: [
            { value: 'gemini-fake-flash', name: 'Gemini Fake Flash' },
            { value: 'gemini-fake-pro', name: 'Gemini Fake Pro' },
        ],
    },
    {
        id: 'thought_level',
        name: 'Thinking',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: ['low', 'medium', 'high'].map((value) => ({ value, name: value })),
    },
];

function call(update: Record<string, unknown>) {
    const merged = mergeAcpToolCall(undefined, { toolCallId: 'call-1', ...update });
    if (!merged) throw new Error('Expected a tool call');
    return merged;
}

describe('antigravityToolPresentation', () => {
    it('names a tool by its Antigravity identifier and reads its PascalCase subject', () => {
        expect(
            mapAcpToolCall(
                call({
                    name: 'view_file',
                    title: 'Read README.md',
                    kind: 'read',
                    status: 'completed',
                    rawInput: { AbsolutePath: '/repo/README.md' },
                }),
                't1',
                false,
                antigravityToolPresentation,
            ),
        ).toMatchObject({ name: 'Read', summary: '/repo/README.md', status: 'completed' });
    });

    it('keeps an unknown tool identifier as its name', () => {
        expect(
            mapAcpToolCall(
                call({ name: 'browser_subagent', title: 'Browse', kind: 'other' }),
                undefined,
                false,
                antigravityToolPresentation,
            ),
        ).toMatchObject({ name: 'browser_subagent' });
    });

    it('reads a shell command from CommandLine and asks for it as a command', () => {
        const command = call({
            name: 'run_command',
            title: 'git status',
            kind: 'execute',
            rawInput: { CommandLine: 'git status --short', Cwd: '/repo' },
        });
        expect(mapAcpToolCall(command, 't1', false, antigravityToolPresentation)).toMatchObject({
            type: 'command',
            command: 'git status --short',
        });
        expect(
            mapAcpPermission(
                command,
                [
                    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
                ],
                antigravityToolPresentation,
            ),
        ).toMatchObject({ kind: 'command', command: 'git status --short' });
    });
});

describe('Antigravity config options', () => {
    it('lists each model once with the thinking levels as its efforts', () => {
        expect(antigravityModels(CONFIG_OPTIONS)).toEqual([
            {
                id: 'gemini-fake-flash',
                displayName: 'Gemini Fake Flash',
                efforts: ['low', 'medium', 'high'],
                defaultEffort: 'high',
            },
            {
                id: 'gemini-fake-pro',
                displayName: 'Gemini Fake Pro',
                efforts: ['low', 'medium', 'high'],
                defaultEffort: 'high',
            },
        ]);
    });

    it('reads the current model and thinking level', () => {
        expect(antigravityConfigState(CONFIG_OPTIONS)).toEqual({
            model: 'gemini-fake-flash',
            effort: 'high',
        });
        expect(antigravityConfigState(undefined)).toEqual({});
    });
});

describe('antigravityUsage', () => {
    it('reads the standard usage total with an estimated cache lifetime', () => {
        expect(
            antigravityUsage({ stopReason: 'end_turn', usage: { totalTokens: 900 } }, 5),
        ).toEqual({ totalTokens: 900, cacheTtlMinutes: 60, lastResponseAt: 5 });
        expect(antigravityUsage({ stopReason: 'end_turn' }, 5)).toBeUndefined();
    });
});

describe('AcpUpdates replay for Antigravity', () => {
    it('settles every replayed turn as completed, since agy reports no turn ends', () => {
        const updates = new AcpUpdates({
            apply: () => {},
            activeTurnId: () => {},
            presentation: antigravityToolPresentation,
        });
        updates.beginReplay();
        const text = (value: string) => ({ content: { type: 'text', text: value } });
        updates.onSessionUpdate({ sessionUpdate: 'user_message_chunk', ...text('first') });
        updates.onSessionUpdate({ sessionUpdate: 'agent_message_chunk', ...text('One.') });
        updates.onSessionUpdate({ sessionUpdate: 'user_message_chunk', ...text('second') });
        updates.onSessionUpdate({ sessionUpdate: 'agent_message_chunk', ...text('Two.') });
        const turns = updates
            .endReplay(true, 'completed')
            .flatMap((operation) =>
                operation.op === 'state' ? (operation.state.turns ?? []) : [],
            );
        expect(turns.map((turn) => turn.status)).toEqual(['completed', 'completed']);
    });
});

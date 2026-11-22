import { describe, expect, it } from 'vitest';

import type { AcpToolCall } from '../../acp/items';
import { mapAcpPermission, mapAcpToolCall, mergeAcpToolCall } from '../../acp/items';
import { AcpUpdates } from '../../acp/updates';
import {
    antigravityConfigState,
    antigravityMode,
    antigravityModels,
    antigravityPermission,
    antigravityProposedPlan,
    antigravityToolPresentation,
    antigravityUsage,
    isAntigravityUsageLimitError,
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
            antigravityUsage({ stopReason: 'end_turn', usage: { totalTokens: 900 } }, undefined, 5),
        ).toEqual({ totalTokens: 900, cacheTtlMinutes: 60, lastResponseAt: 5 });
        expect(antigravityUsage({ stopReason: 'end_turn' }, undefined, 5)).toBeUndefined();
    });

    it('prefers the context a usage_update reported, with its window', () => {
        expect(
            antigravityUsage(
                { stopReason: 'end_turn', usage: { totalTokens: 900 } },
                { used: 8_693, size: 1_048_576 },
                5,
            ),
        ).toEqual({
            totalTokens: 8_693,
            contextWindow: 1_048_576,
            cacheTtlMinutes: 60,
            lastResponseAt: 5,
        });
    });
});

describe('antigravity session modes', () => {
    it('maps each permission to the mode agy acp runs it in, plan mode first', () => {
        expect(antigravityMode({ permissionMode: 'ask', planMode: false })).toBe('default');
        expect(antigravityMode({ permissionMode: 'acceptEdits', planMode: false })).toBe(
            'accept-edits',
        );
        expect(antigravityMode({ permissionMode: 'auto', planMode: false })).toBe('auto');
        expect(antigravityMode({ permissionMode: 'fullAccess', planMode: false })).toBe('default');
        expect(antigravityMode({ permissionMode: 'auto', planMode: true })).toBe('plan');
    });

    it('reads a reported mode back, keeping full access for a process launched with it', () => {
        const current = { permissionMode: 'acceptEdits' as const, planMode: false };
        expect(antigravityPermission('plan', current, false)).toEqual({
            permissionMode: 'acceptEdits',
            planMode: true,
        });
        expect(antigravityPermission('auto', current, false)).toEqual({
            permissionMode: 'auto',
            planMode: false,
        });
        expect(antigravityPermission('default', current, true)).toEqual({
            permissionMode: 'fullAccess',
            planMode: false,
        });
        expect(antigravityPermission('unknown-mode', current, false)).toBeUndefined();
    });
});

describe('antigravityProposedPlan', () => {
    const call = (rawInput: Record<string, unknown>): AcpToolCall => ({
        id: 'call-1',
        toolName: 'write_file',
        title: 'File plan.md',
        kind: 'edit',
        status: 'completed',
        rawInput,
        content: [],
    });

    it('reads the plan artifact a feedback request carries', () => {
        expect(
            antigravityProposedPlan(
                call({
                    Content: '# Plan\n\n1. Append world\n',
                    ArtifactMetadata: { RequestFeedback: true, UserFacing: true },
                }),
            ),
        ).toBe('# Plan\n\n1. Append world');
    });

    it('ignores an ordinary file write', () => {
        expect(
            antigravityProposedPlan(call({ Content: 'world\n', Path: '/tmp/hello.txt' })),
        ).toBeUndefined();
    });
});

describe('isAntigravityUsageLimitError', () => {
    it('recognizes a used-up quota but not other failures', () => {
        expect(isAntigravityUsageLimitError('You have exhausted your quota on this model.')).toBe(
            true,
        );
        expect(isAntigravityUsageLimitError('429 RESOURCE_EXHAUSTED')).toBe(true);
        expect(isAntigravityUsageLimitError('connection reset')).toBe(false);
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

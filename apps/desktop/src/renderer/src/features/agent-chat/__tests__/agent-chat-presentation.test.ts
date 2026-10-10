import type { AgentChatSnapshot } from '@caxri/protocol';
import { emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatActivity,
    agentChatCommandCwd,
    agentChatContextUsage,
    agentChatEffortLabel,
    agentChatFailureMessage,
    agentChatModelLabel,
    agentChatPlanProgress,
    agentChatQuestionAnswers,
    agentChatRequestTitle,
    agentChatWorkingVerb,
    canSendAgentChatMessage,
    isAgentChatInterruptKey,
    isAgentChatSubmitKey,
    withOccurrenceKeys,
} from '../agent-chat-presentation';

function snapshot(status: AgentChatSnapshot['status']): AgentChatSnapshot {
    return { ...emptyAgentChatSnapshot('terminal-1'), status };
}

describe('canSendAgentChatMessage', () => {
    it('accepts a message while ready, stopped (which resumes), or still starting (which queues)', () => {
        expect(canSendAgentChatMessage(snapshot('ready'))).toBe(true);
        expect(canSendAgentChatMessage(snapshot('stopped'))).toBe(true);
        expect(canSendAgentChatMessage(snapshot('starting'))).toBe(true);
    });

    it('refuses once the provider has failed or before anything is loaded', () => {
        expect(canSendAgentChatMessage(snapshot('failed'))).toBe(false);
        expect(canSendAgentChatMessage(undefined)).toBe(false);
    });
});

describe('isAgentChatSubmitKey', () => {
    it('sends on Enter only', () => {
        expect(isAgentChatSubmitKey({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(
            true,
        );
        expect(isAgentChatSubmitKey({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(
            false,
        );
    });

    it('leaves Enter to an IME composition', () => {
        expect(isAgentChatSubmitKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(
            false,
        );
    });
});

describe('agentChatQuestionAnswers', () => {
    it('prefers typed Other text over a chosen option and omits unanswered questions', () => {
        expect(
            agentChatQuestionAnswers(
                { q1: 'Yes', q2: 'No', q3: undefined },
                { q2: '  Later  ', q4: ' '.repeat(3) },
            ),
        ).toEqual({ q1: ['Yes'], q2: ['Later'] });
    });
});

describe('withOccurrenceKeys', () => {
    it('keys entries by content and numbers repeated values', () => {
        expect(
            withOccurrenceKeys(['Read', 'Test', 'Read'], (step) => step).map(({ key }) => key),
        ).toEqual(['Read\u{0}0', 'Test\u{0}0', 'Read\u{0}1']);
    });
});

describe('agentChatCommandCwd', () => {
    it('hides the Project root, shortens paths below it, and keeps paths outside it absolute', () => {
        expect(agentChatCommandCwd('/work/app', '/work/app')).toBeUndefined();
        expect(agentChatCommandCwd('/work/app/packages/ui', '/work/app')).toBe('packages/ui');
        expect(agentChatCommandCwd('/tmp/scratch', '/work/app')).toBe('/tmp/scratch');
        expect(agentChatCommandCwd('/work/app', undefined)).toBe('/work/app');
        expect(agentChatCommandCwd(undefined, '/work/app')).toBeUndefined();
    });
});

describe('agentChatContextUsage', () => {
    it('reports the share of the window in use once the provider reports its size', () => {
        expect(agentChatContextUsage(undefined)).toBeUndefined();
        expect(agentChatContextUsage({ usage: { totalTokens: 500 } })).toBeUndefined();
        expect(
            agentChatContextUsage({ usage: { totalTokens: 25_000, contextWindow: 100_000 } }),
        ).toEqual({ used: 0.25, totalTokens: 25_000, contextWindow: 100_000 });
        expect(
            agentChatContextUsage({ usage: { totalTokens: 200_000, contextWindow: 100_000 } })
                ?.used,
        ).toBe(1);
    });
});

describe('agentChatModelLabel', () => {
    const models = [
        { id: 'opus', resolvedId: 'claude-opus-5-5', displayName: 'Opus', efforts: ['high'] },
        { id: 'plain', displayName: 'Plain', efforts: [] },
    ];

    it('names the listed model and the effort the next turn uses', () => {
        expect(agentChatModelLabel(undefined)).toBeUndefined();
        // Claude Code lists its models before its first turn names the one in use.
        expect(agentChatModelLabel({ models })).toEqual({ model: 'Default' });
        expect(agentChatModelLabel({ model: 'claude-opus-5-5', effort: 'xhigh', models })).toEqual({
            model: 'Opus',
            effort: 'Extra high',
        });
        expect(agentChatModelLabel({ model: 'gpt-raw' })).toEqual({ model: 'gpt-raw' });
        // A model without effort control never shows a stale effort from the previous model.
        expect(agentChatModelLabel({ model: 'plain', effort: 'high', models })).toEqual({
            model: 'Plain',
        });
    });

    it('labels known efforts and capitalizes unknown ones', () => {
        expect(agentChatEffortLabel('max')).toBe('Max');
        expect(agentChatEffortLabel('turbo')).toBe('Turbo');
    });
});

describe('agentChatActivity', () => {
    it('tells starting, working, and waiting on the user apart', () => {
        expect(agentChatActivity(undefined, 'Claude')).toEqual({
            kind: 'starting',
            text: 'Starting Claude…',
        });
        expect(agentChatActivity(snapshot('ready'), 'Codex')).toBeUndefined();
        const running = {
            ...snapshot('ready'),
            activeTurnId: 'turn-1',
            turns: [{ id: 'turn-1', status: 'running' as const, startedAt: 1000 }],
        };
        expect(agentChatActivity(running, 'Codex')).toEqual({
            kind: 'working',
            text: `${agentChatWorkingVerb('turn-1')}…`,
            startedAt: 1000,
        });
        expect(
            agentChatActivity(
                {
                    ...running,
                    requests: [{ id: 'r', kind: 'fileChange' }],
                },
                'Codex',
            ),
        ).toEqual({ kind: 'waiting', text: 'Waiting for your answer' });
    });

    it('keeps one verb for a turn and varies it across turns', () => {
        expect(agentChatWorkingVerb('turn-1')).toBe(agentChatWorkingVerb('turn-1'));
        const verbs = new Set(
            Array.from({ length: 40 }, (_, index) => agentChatWorkingVerb(`turn-${index}`)),
        );
        expect(verbs.size).toBeGreaterThan(5);
    });
});

describe('isAgentChatInterruptKey', () => {
    it('interrupts on a single Escape outside an IME composition', () => {
        expect(isAgentChatInterruptKey({ key: 'Escape', isComposing: false, repeat: false })).toBe(
            true,
        );
        expect(isAgentChatInterruptKey({ key: 'Escape', isComposing: true, repeat: false })).toBe(
            false,
        );
        expect(isAgentChatInterruptKey({ key: 'Escape', isComposing: false, repeat: true })).toBe(
            false,
        );
        expect(isAgentChatInterruptKey({ key: 'Enter', isComposing: false, repeat: false })).toBe(
            false,
        );
    });
});

describe('agentChatFailureMessage', () => {
    it('names the Chat provider', () => {
        expect(agentChatFailureMessage('process_exited', 'Claude')).toBe(
            'Claude stopped unexpectedly. Retry to resume the conversation.',
        );
    });
});

describe('agentChatRequestTitle', () => {
    it('asks about a generic tool by name', () => {
        expect(
            agentChatRequestTitle({
                id: 'r',
                kind: 'tool',
                name: 'WebFetch',
                decisions: ['accept'],
            }),
        ).toBe('Allow WebFetch?');
    });

    it('asks to start with the plan Claude Code proposes', () => {
        expect(
            agentChatRequestTitle({
                id: 'r',
                kind: 'tool',
                name: 'ExitPlanMode',
                decisions: ['accept'],
            }),
        ).toBe('Start with this plan?');
    });
});

describe('agentChatPlanProgress', () => {
    it('counts completed steps and names the one in progress', () => {
        expect(
            agentChatPlanProgress({
                steps: [
                    { step: 'Read', status: 'completed' },
                    { step: 'Edit', status: 'pending' },
                    { step: 'Test', status: 'inProgress' },
                ],
            }),
        ).toEqual({ completed: 1, total: 3, current: 'Test' });
    });

    it('falls back to the first pending step, then to none once done', () => {
        expect(
            agentChatPlanProgress({
                steps: [
                    { step: 'Read', status: 'completed' },
                    { step: 'Edit', status: 'pending' },
                ],
            }).current,
        ).toBe('Edit');
        expect(agentChatPlanProgress({ steps: [{ step: 'Read', status: 'completed' }] })).toEqual({
            completed: 1,
            total: 1,
            current: undefined,
        });
    });
});

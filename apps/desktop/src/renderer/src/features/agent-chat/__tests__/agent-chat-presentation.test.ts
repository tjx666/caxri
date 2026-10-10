import type { AgentChatSnapshot } from '@caxri/protocol';
import { emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatActivity,
    agentChatCommandCwd,
    agentChatContextSummary,
    agentChatFailureMessage,
    agentChatQuestionAnswers,
    agentChatRequestTitle,
    agentChatSendAction,
    agentChatSubmitDelivery,
    agentChatWorkingVerb,
    canSendAgentChatMessage,
    isAgentChatBusy,
    isAgentChatInterruptKey,
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

describe('agentChatSendAction', () => {
    it('sends when idle, queues while busy, and offers steering only during a turn', () => {
        expect(agentChatSendAction({ isTurnRunning: false, isBusy: false }, 'Codex')).toEqual({
            label: 'Send',
            tooltip: 'Send',
            placeholder: 'Message Codex',
        });
        expect(agentChatSendAction({ isTurnRunning: false, isBusy: true }, 'Codex').label).toBe(
            'Queue message',
        );
        expect(agentChatSendAction({ isTurnRunning: true, isBusy: true }, 'Codex')).toMatchObject({
            label: 'Queue message',
            placeholder: 'Queue a follow-up (⌘Enter to steer)',
        });
    });
});

describe('agentChatSubmitDelivery', () => {
    const key = (overrides: Partial<Parameters<typeof agentChatSubmitDelivery>[0]> = {}) => ({
        key: 'Enter',
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        isComposing: false,
        ...overrides,
    });
    const idle = { isTurnRunning: false, isBusy: false };
    const running = { isTurnRunning: true, isBusy: true };

    it('sends on Enter when idle, with or without Cmd', () => {
        expect(agentChatSubmitDelivery(key(), idle)).toBe('send');
        expect(agentChatSubmitDelivery(key({ metaKey: true }), idle)).toBe('send');
    });

    it('queues on Enter and steers on Cmd+Enter or Ctrl+Enter while a turn runs', () => {
        expect(agentChatSubmitDelivery(key(), running)).toBe('queue');
        expect(agentChatSubmitDelivery(key({ metaKey: true }), running)).toBe('steer');
        expect(agentChatSubmitDelivery(key({ ctrlKey: true }), running)).toBe('steer');
    });

    it('queues while compacting even with Cmd, since there is no turn to steer', () => {
        expect(
            agentChatSubmitDelivery(key({ metaKey: true }), { isTurnRunning: false, isBusy: true }),
        ).toBe('queue');
    });

    it('leaves Shift+Enter, other keys, and an IME composition alone', () => {
        expect(agentChatSubmitDelivery(key({ shiftKey: true }), idle)).toBeUndefined();
        expect(agentChatSubmitDelivery(key({ isComposing: true }), running)).toBeUndefined();
        expect(agentChatSubmitDelivery(key({ key: 'a' }), idle)).toBeUndefined();
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

describe('agentChatContextSummary', () => {
    it('shows the model and the context left once the provider reports them', () => {
        expect(agentChatContextSummary(undefined)).toBeUndefined();
        expect(agentChatContextSummary({})).toBeUndefined();
        expect(agentChatContextSummary({ model: 'gpt-test' })).toBe('gpt-test');
        expect(
            agentChatContextSummary({
                model: 'gpt-test',
                usage: { totalTokens: 25_000, contextWindow: 100_000 },
            }),
        ).toBe('gpt-test · 75% context left');
        expect(agentChatContextSummary({ usage: { totalTokens: 500 } })).toBeUndefined();
        expect(
            agentChatContextSummary({ usage: { totalTokens: 200_000, contextWindow: 100_000 } }),
        ).toBe('0% context left');
    });
});

describe('agentChatActivity while compacting', () => {
    it('names compaction instead of a working verb, stoppable only inside a turn', () => {
        expect(
            agentChatActivity({ ...snapshot('ready'), operation: 'compacting' }, 'Claude'),
        ).toEqual({
            kind: 'compacting',
            text: 'Compacting context…',
            isStoppable: false,
        });
        expect(
            agentChatActivity(
                { ...snapshot('ready'), operation: 'compacting', activeTurnId: 'turn-1' },
                'Claude',
            ),
        ).toMatchObject({ kind: 'compacting', isStoppable: true });
    });
});

describe('isAgentChatBusy', () => {
    it('queues behind a running turn, a compaction, or an unpaused queue', () => {
        expect(isAgentChatBusy(snapshot('ready'))).toBe(false);
        expect(isAgentChatBusy({ ...snapshot('ready'), activeTurnId: 'turn-1' })).toBe(true);
        expect(isAgentChatBusy({ ...snapshot('ready'), operation: 'compacting' })).toBe(true);
        const queued = { ...snapshot('ready'), queue: [{ id: 'q1', text: 'next' }] };
        expect(isAgentChatBusy(queued)).toBe(true);
        expect(isAgentChatBusy({ ...queued, queuePaused: true })).toBe(false);
        expect(isAgentChatBusy(undefined)).toBe(false);
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

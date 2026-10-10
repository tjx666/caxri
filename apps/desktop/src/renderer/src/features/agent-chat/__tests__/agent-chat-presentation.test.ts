import type { AgentChatSnapshot } from '@caxri/protocol';
import { emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatActivityLabel,
    agentChatCommandCwd,
    agentChatContextSummary,
    agentChatFailureMessage,
    agentChatQuestionAnswers,
    agentChatRequestTitle,
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

describe('agentChatActivityLabel', () => {
    it('tells starting, working, and waiting on the user apart', () => {
        expect(agentChatActivityLabel(undefined, 'Claude Code')).toEqual({
            text: 'Starting Claude Code…',
            isBusy: true,
        });
        expect(agentChatActivityLabel(snapshot('ready'), 'Codex')).toBeUndefined();
        const running = { ...snapshot('ready'), activeTurnId: 'turn-1' };
        expect(agentChatActivityLabel(running, 'Codex')).toEqual({
            text: 'Working…',
            isBusy: true,
        });
        expect(
            agentChatActivityLabel(
                {
                    ...running,
                    requests: [{ id: 'r', kind: 'fileChange' }],
                },
                'Codex',
            ),
        ).toEqual({ text: 'Waiting for your answer', isBusy: false });
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
        expect(agentChatFailureMessage('process_exited', 'Claude Code')).toBe(
            'Claude Code stopped unexpectedly. Retry to resume the conversation.',
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

import type { AgentChatSnapshot } from '@caxri/protocol';
import { emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { getTerminalExitPresentation } from '../../terminal/terminal-exit-presentation';
import {
    agentChatActivity,
    agentChatCommandCwd,
    agentChatDeliveryCaption,
    agentChatEffortLabel,
    agentChatEmptyMessage,
    agentChatFailureMessage,
    agentChatModelLabel,
    agentChatPlanProgress,
    agentChatQuestionAnswers,
    agentChatRecoveryNotice,
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
        expect(canSendAgentChatMessage(snapshot('ready'), 'running')).toBe(true);
        expect(canSendAgentChatMessage(snapshot('stopped'), 'stopped')).toBe(true);
        expect(canSendAgentChatMessage(snapshot('starting'), 'starting')).toBe(true);
        expect(canSendAgentChatMessage(snapshot('stopped'), undefined)).toBe(true);
    });

    it('refuses once the provider has failed or before anything is loaded', () => {
        expect(canSendAgentChatMessage(snapshot('failed'), 'failed')).toBe(false);
        expect(canSendAgentChatMessage(undefined, 'running')).toBe(false);
    });

    it('refuses a Chat handed to another client even though its projection reads stopped', () => {
        expect(canSendAgentChatMessage(snapshot('stopped'), 'detached')).toBe(false);
    });
});

describe('agentChatEmptyMessage', () => {
    it('invites the first message only once an empty Chat is ready', () => {
        expect(agentChatEmptyMessage(snapshot('ready'), 'running', 'Codex')).toBe(
            'Send a message to start working with Codex.',
        );
        expect(agentChatEmptyMessage(snapshot('starting'), 'starting', 'Codex')).toBeUndefined();
        expect(agentChatEmptyMessage(undefined, 'running', 'Codex')).toBeUndefined();
    });

    it('explains the blank transcript of a Chat handed to another client', () => {
        expect(agentChatEmptyMessage(snapshot('stopped'), 'detached', 'Codex')).toBe(
            'Messages appear here once the Chat resumes.',
        );
    });

    it('stays out of a transcript that has messages', () => {
        const withItem: AgentChatSnapshot = {
            ...snapshot('stopped'),
            items: [{ id: 'item-1', type: 'userMessage', text: 'hello' }],
        };
        expect(agentChatEmptyMessage(withItem, 'detached', 'Codex')).toBeUndefined();
    });
});

describe('agentChatRecoveryNotice', () => {
    const settled = { isLoadError: false, processState: 'stopped' } as const;

    it('shows nothing while the Chat can continue', () => {
        expect(agentChatRecoveryNotice(snapshot('stopped'), settled, 'Codex')).toBeUndefined();
        expect(agentChatRecoveryNotice(undefined, settled, 'Codex')).toBeUndefined();
    });

    it('names a hand-over with the PTY copy and resumes it by restarting the Terminal', () => {
        expect(
            agentChatRecoveryNotice(
                snapshot('stopped'),
                { isLoadError: false, processState: 'detached' },
                'Codex',
            ),
        ).toEqual({
            kind: 'detached',
            message: getTerminalExitPresentation('detached')?.label,
            recovery: 'restart',
        });
    });

    it('prefers the hand-over to an older provider failure', () => {
        expect(
            agentChatRecoveryNotice(
                { status: 'failed', failure: { reason: 'process_exited' } },
                { isLoadError: false, processState: 'detached' },
                'Codex',
            )?.kind,
        ).toBe('detached');
    });

    it('restarts a failed provider and keeps its detail beside the closed message', () => {
        expect(
            agentChatRecoveryNotice(
                { status: 'failed', failure: { reason: 'spawn_failed', detail: 'EACCES' } },
                { isLoadError: false, processState: 'failed' },
                'Codex',
            ),
        ).toEqual({
            kind: 'failed',
            message: agentChatFailureMessage('spawn_failed', 'Codex'),
            detail: 'EACCES',
            recovery: 'restart',
        });
    });

    it('reloads a projection that could not be read', () => {
        expect(
            agentChatRecoveryNotice(
                undefined,
                { isLoadError: true, processState: 'running' },
                'Codex',
            ),
        ).toEqual({
            kind: 'failed',
            message: 'The conversation could not be loaded.',
            recovery: 'reload',
        });
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

describe('agentChatModelLabel', () => {
    const models = [
        { id: 'opus', resolvedId: 'claude-opus-5-5', displayName: 'Opus', efforts: ['high'] },
        { id: 'plain', displayName: 'Plain', efforts: [] },
    ];

    it('names the listed model and the effort the next turn uses', () => {
        expect(agentChatModelLabel(undefined)).toBeUndefined();
        // Claude Code lists its models before its first turn names the one in use.
        expect(agentChatModelLabel({ models })).toEqual({ model: 'Default' });
        // Claude Code reports the effort it will apply before that first turn.
        expect(agentChatModelLabel({ effort: 'medium', models })).toEqual({
            model: 'Default',
            effort: 'Medium',
        });
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

    it('names the model Claude Code runs for its default alias instead of the alias', () => {
        const aliased = [
            {
                id: 'default',
                resolvedId: 'claude-opus-5-5[1m]',
                displayName: 'Default (recommended)',
                efforts: ['high'],
            },
            ...models,
        ];
        expect(agentChatModelLabel({ model: 'claude-opus-5-5[1m]', models: aliased })).toEqual({
            model: 'Opus',
        });
        expect(
            agentChatModelLabel({
                model: 'claude-opus-5-5[1m]',
                models: [
                    { ...aliased[0], description: 'Use the default model (currently Opus 5.5)' },
                    ...models,
                ],
            }),
        ).toEqual({ model: 'Opus 5.5' });
        // Without a named twin the alias still reads short.
        expect(
            agentChatModelLabel({ model: 'claude-opus-5-5[1m]', models: aliased.slice(0, 1) }),
        ).toEqual({ model: 'Default' });
    });

    it('labels known efforts and capitalizes unknown ones', () => {
        expect(agentChatEffortLabel('max')).toBe('Max');
        expect(agentChatEffortLabel('turbo')).toBe('Turbo');
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
            agentChatRequestTitle(
                {
                    id: 'r',
                    kind: 'tool',
                    name: 'WebFetch',
                    decisions: ['accept'],
                },
                'Claude Code',
            ),
        ).toBe('Allow WebFetch?');
    });

    it("asks in the timeline's words instead of the raw tool identifier", () => {
        const tool = (name: string, summary?: string) =>
            agentChatRequestTitle(
                { id: 'r', kind: 'tool', name, ...(summary && { summary }), decisions: ['accept'] },
                'Claude Code',
            );
        expect(tool('mcp__github__create_issue', '{"title":"x"}')).toBe(
            'Allow create_issue from github?',
        );
        expect(tool('Edit', '/work/src/app.ts')).toBe('Allow editing app.ts?');
        expect(tool('WebFetch', `https://example.com/${'a'.repeat(80)}`)).toBe('Allow browsing?');
    });

    it('names the provider that asks a question', () => {
        const question = {
            id: 'q',
            header: '',
            question: 'Which?',
            options: [],
            allowsOther: true,
        };
        expect(
            agentChatRequestTitle(
                { id: 'r', kind: 'question', questions: [question] },
                'Claude Code',
            ),
        ).toBe('Claude Code has a question');
        expect(
            agentChatRequestTitle(
                { id: 'r', kind: 'question', questions: [question, { ...question, id: 'q2' }] },
                'Codex',
            ),
        ).toBe('Codex has 2 questions');
    });

    it('asks to start with the plan Claude Code proposes', () => {
        expect(
            agentChatRequestTitle(
                {
                    id: 'r',
                    kind: 'tool',
                    name: 'ExitPlanMode',
                    decisions: ['accept'],
                },
                'Claude Code',
            ),
        ).toBe('Start with this plan?');
    });
});

describe('agentChatDeliveryCaption', () => {
    it('captions a steered message and drops the caption once a queued one was delivered', () => {
        expect(agentChatDeliveryCaption('steered')).toBe('Steered');
        expect(agentChatDeliveryCaption('queued')).toBeUndefined();
        expect(agentChatDeliveryCaption(undefined)).toBeUndefined();
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

import { describe, expect, it } from 'vitest';

import type { AgentChatFailureReason, AgentChatSnapshot } from '../agent-chat-contract.js';
import {
    agentChatActivity,
    agentChatDockedPlan,
    agentChatFailureMessage,
    agentChatItemStatusLabel,
    agentChatItemStatusTone,
    agentChatNextUnansweredQuestion,
    agentChatNoticeMessage,
    agentChatPlanProgress,
    agentChatQuestionAnswers,
    agentChatQuestionDefaults,
    agentChatQuestionMultiDefaults,
    agentChatQuestionOption,
    agentChatWorkingVerb,
    isAgentChatItemVisible,
    sentenceStartProvider,
    toggleAgentChatQuestionOption,
} from '../agent-chat-presentation.js';
import { emptyAgentChatSnapshot } from '../agent-chat-reducer.js';
import type { AgentChatRequest } from '../agent-chat-requests.js';

describe('agentChatFailureMessage', () => {
    it('keeps the Desktop copy, which names the next step on the same machine', () => {
        const desktop = (reason: AgentChatFailureReason) =>
            agentChatFailureMessage(reason, { providerName: 'Codex', surface: 'desktop' });
        expect(desktop('executable_not_found')).toBe(
            "Caxri couldn't find Codex. Install it, or set its location in Settings.",
        );
        expect(desktop('spawn_failed')).toBe(
            'Codex could not be started. Retry, or check that the Codex CLI runs in a terminal.',
        );
        expect(desktop('handshake_failed')).toBe(
            'Codex started but did not respond. Retry, or update the Codex CLI.',
        );
        expect(desktop('process_exited')).toBe(
            'Codex stopped unexpectedly. Retry to resume the conversation.',
        );
        expect(desktop('resume_failed')).toBe('The previous conversation could not be resumed.');
        expect(desktop('conversation_in_use')).toBe(
            'This conversation is open in another Codex app or window.',
        );
        expect(desktop('unsupported_version')).toBe(
            'This Codex version does not support Chat. Update the Codex CLI.',
        );
    });

    it('keeps the phone copy, which places the provider on the computer', () => {
        const mobile = (reason: AgentChatFailureReason) =>
            agentChatFailureMessage(reason, { providerName: 'Codex', surface: 'mobile' });
        expect(mobile('executable_not_found')).toBe(
            "Codex is not installed or is not on your computer's PATH. Install it on your computer.",
        );
        expect(mobile('spawn_failed')).toBe('Codex could not be started on your computer.');
        expect(mobile('handshake_failed')).toBe('Codex started but did not respond.');
        expect(mobile('process_exited')).toBe(
            'Codex stopped unexpectedly. Retry to resume the conversation.',
        );
        expect(mobile('resume_failed')).toBe('The previous conversation could not be resumed.');
        expect(mobile('conversation_in_use')).toBe(
            'This conversation is open in another Codex app or window on your computer.',
        );
        expect(mobile('unsupported_version')).toBe(
            'This Codex version does not support Chat. Update it on your computer.',
        );
    });

    it('asks only a phone that can retry to retry a stopped provider', () => {
        expect(
            agentChatFailureMessage('process_exited', {
                canRetry: false,
                providerName: 'Claude',
                surface: 'mobile',
            }),
        ).toBe('Claude stopped unexpectedly. Reply access is required to retry.');
        expect(
            agentChatFailureMessage('process_exited', {
                canRetry: false,
                providerName: 'Claude',
                surface: 'desktop',
            }),
        ).toBe('Claude stopped unexpectedly. Retry to resume the conversation.');
    });

    it('starts a phone sentence with a capital when the provider falls back to the Agent', () => {
        expect(sentenceStartProvider('the Agent')).toBe('The Agent');
        expect(sentenceStartProvider('Codex')).toBe('Codex');
        expect(
            agentChatFailureMessage('spawn_failed', {
                providerName: 'the Agent',
                surface: 'mobile',
            }),
        ).toBe('The Agent could not be started on your computer.');
    });
});

describe('agentChatQuestionOption', () => {
    it('turns the Recommended suffix into a flag and keeps every other label as is', () => {
        expect(agentChatQuestionOption('Rebase onto main (Recommended)')).toEqual({
            isRecommended: true,
            text: 'Rebase onto main',
        });
        expect(agentChatQuestionOption('Merge (recommended) ')).toEqual({
            isRecommended: true,
            text: 'Merge',
        });
        expect(agentChatQuestionOption('秋天（推荐）')).toEqual({
            isRecommended: true,
            text: '秋天',
        });
        expect(agentChatQuestionOption('Rebase (推荐)')).toEqual({
            isRecommended: true,
            text: 'Rebase',
        });
        expect(agentChatQuestionOption('Recommended settings')).toEqual({
            isRecommended: false,
            text: 'Recommended settings',
        });
        expect(agentChatQuestionOption('(Recommended)')).toEqual({
            isRecommended: false,
            text: '(Recommended)',
        });
    });
});

describe('agentChatQuestionAnswers', () => {
    const request: Extract<AgentChatRequest, { kind: 'question' }> = {
        id: 'q',
        kind: 'question',
        questions: [
            {
                id: 'a',
                header: 'Pick',
                question: 'Which?',
                options: [{ label: 'One', description: '' }],
                allowsOther: true,
            },
            { id: 'b', header: 'Reason', question: 'Why?', options: [], allowsOther: true },
        ],
    };

    it('reports a question left unanswered as incomplete and omits it', () => {
        expect(
            agentChatQuestionAnswers(request, { a: 'One', b: undefined }, { b: ' '.repeat(3) }),
        ).toEqual({
            answers: { a: ['One'] },
            isComplete: false,
        });
    });

    it('prefers typed Other text over a chosen option', () => {
        expect(
            agentChatQuestionAnswers(request, { a: 'One' }, { a: ' Two ', b: 'Because' }),
        ).toEqual({ answers: { a: ['Two'], b: ['Because'] }, isComplete: true });
    });

    it('ignores a selection for a question the request does not ask', () => {
        expect(
            agentChatQuestionAnswers(request, { a: 'One', stale: 'Old' }, { b: 'Why not' }),
        ).toEqual({ answers: { a: ['One'], b: ['Why not'] }, isComplete: true });
    });
});

describe('multiSelect questions', () => {
    const request: Extract<AgentChatRequest, { kind: 'question' }> = {
        id: 'q',
        kind: 'question',
        questions: [
            {
                id: 'tools',
                header: 'Tools',
                question: 'Which tools?',
                options: [
                    { label: 'Lint (Recommended)', description: '' },
                    { label: 'Test', description: '' },
                    { label: 'Build', description: '' },
                ],
                allowsOther: true,
                multiSelect: true,
            },
            {
                id: 'mode',
                header: 'Mode',
                question: 'Which mode?',
                options: [{ label: 'Fast (Recommended)', description: '' }],
                allowsOther: true,
            },
        ],
    };

    it('answers every ticked option, then the typed one', () => {
        expect(
            agentChatQuestionAnswers(
                request,
                { tools: ['Test', 'Lint (Recommended)'], mode: 'Fast (Recommended)' },
                { tools: ' Format ' },
            ),
        ).toEqual({
            answers: {
                tools: ['Test', 'Lint (Recommended)', 'Format'],
                mode: ['Fast (Recommended)'],
            },
            isComplete: true,
        });
    });

    it('leaves a multiSelect question with nothing ticked unanswered', () => {
        expect(agentChatQuestionAnswers(request, { tools: [] }, {}).answers).not.toHaveProperty(
            'tools',
        );
    });

    it('answers a single-choice question with one option even when handed several', () => {
        expect(agentChatQuestionAnswers(request, { mode: ['A', 'B'] }, {}).answers).toEqual({
            mode: ['A'],
        });
    });

    it('starts only multiSelect questions ticked, on their recommendation', () => {
        expect(agentChatQuestionMultiDefaults(request)).toEqual({ tools: ['Lint (Recommended)'] });
    });

    it('toggles an option and keeps the ticking order', () => {
        expect(toggleAgentChatQuestionOption(['Test'], 'Build')).toEqual(['Test', 'Build']);
        expect(toggleAgentChatQuestionOption(['Test', 'Build'], 'Test')).toEqual(['Build']);
    });
});

describe('multi-question navigation', () => {
    const question = (id: string, labels: string[]) => ({
        id,
        header: id,
        question: `${id}?`,
        options: labels.map((label) => ({ label, description: '' })),
        allowsOther: false,
    });
    const request: Extract<AgentChatRequest, { kind: 'question' }> = {
        id: 'q',
        kind: 'question',
        questions: [
            question('a', ['One', 'Two (Recommended)']),
            question('b', ['Yes', 'No']),
            question('c', ['Left', 'Right']),
        ],
    };

    it('preselects only recommended options', () => {
        expect(agentChatQuestionDefaults(request)).toEqual({ a: 'Two (Recommended)' });
    });

    it('moves to the next unanswered question, wrapping, until none remain', () => {
        const all = new Set([0, 1, 2]);
        expect(agentChatNextUnansweredQuestion(request, { a: ['One'] }, 0, all)).toBe(1);
        expect(agentChatNextUnansweredQuestion(request, { c: ['Left'] }, 2, all)).toBe(0);
        expect(agentChatNextUnansweredQuestion(request, { a: ['One'], c: ['Left'] }, 2, all)).toBe(
            1,
        );
        expect(
            agentChatNextUnansweredQuestion(
                request,
                { a: ['One'], b: ['Yes'], c: ['Left'] },
                1,
                all,
            ),
        ).toBeUndefined();
        // The question just answered is never its own next step.
        expect(
            agentChatNextUnansweredQuestion(request, { b: ['Yes'], c: ['Left'] }, 0, all),
        ).toBeUndefined();
    });

    it('opens a question the user has not seen even when a default already answers it', () => {
        const answers = { a: ['One'], b: ['Yes (Recommended)'], c: ['Left'] };
        expect(agentChatNextUnansweredQuestion(request, answers, 0, new Set([0]))).toBe(1);
        expect(agentChatNextUnansweredQuestion(request, answers, 1, new Set([0, 1]))).toBe(2);
        expect(
            agentChatNextUnansweredQuestion(request, answers, 2, new Set([0, 1, 2])),
        ).toBeUndefined();
    });
});

function snapshot(status: AgentChatSnapshot['status']): AgentChatSnapshot {
    return { ...emptyAgentChatSnapshot('terminal-1'), status };
}

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

describe('agentChatActivity', () => {
    it("carries the running turn's spend, never an earlier turn's", () => {
        const running = {
            ...snapshot('ready'),
            activeTurnId: 'turn-2',
            turns: [{ id: 'turn-2', status: 'running' as const, startedAt: 1000 }],
        };
        const usage = { turnId: 'turn-2', requests: 3, totalTokens: 1200, costUsd: 0.01 };
        expect(agentChatActivity({ ...running, turnUsage: usage }, 'Claude')).toMatchObject({
            kind: 'working',
            usage,
        });
        expect(
            agentChatActivity({ ...running, turnUsage: { ...usage, turnId: 'turn-1' } }, 'Claude'),
        ).not.toHaveProperty('usage');
    });

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
        ).toEqual({ kind: 'waiting', text: 'Waiting for your approval' });
    });

    it('names the kind of work the active turn runs', () => {
        expect(
            agentChatActivity(
                {
                    ...snapshot('ready'),
                    activeTurnId: 'turn-1',
                    items: [
                        {
                            id: 'c',
                            turnId: 'turn-1',
                            type: 'command',
                            command: 'pnpm test',
                            status: 'running',
                            output: '',
                            createdAt: 50,
                        },
                    ],
                },
                'Codex',
            ),
        ).toMatchObject({ kind: 'working', work: { kind: 'test', startedAt: 50 } });
    });

    it('loads an existing conversation instead of claiming to start the Agent', () => {
        expect(agentChatActivity(undefined, 'Claude', { hasConversation: true })).toEqual({
            kind: 'starting',
            text: 'Loading conversation…',
        });
    });

    it('keeps the hash-to-phrase mapping stable and varies it across turns', () => {
        expect(agentChatWorkingVerb('turn-0')).toBe('Mapping the terrain');
        expect(agentChatWorkingVerb('turn-1')).toBe('Following a bright thread');
        expect(agentChatWorkingVerb('turn-27')).toBe('Giving the idea a spin');
        expect(agentChatWorkingVerb('💡')).toBe('Turning another page');
        const phrases = new Set(
            Array.from({ length: 40 }, (_, index) => agentChatWorkingVerb(`turn-${index}`)),
        );
        expect(phrases.size).toBeGreaterThan(5);
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

describe('agentChatDockedPlan', () => {
    const plan = {
        turnId: 'turn-1',
        steps: [
            { step: 'Read', status: 'completed' as const },
            { step: 'Reply', status: 'inProgress' as const },
        ],
    };

    it('keeps the latest plan docked after its turn ends, with the step no longer spinning', () => {
        expect(agentChatDockedPlan({ plan, activeTurnId: 'turn-1' })).toEqual({
            plan,
            isTurnRunning: true,
        });
        expect(agentChatDockedPlan({ plan })).toEqual({ plan, isTurnRunning: false });
        expect(agentChatDockedPlan({ activeTurnId: 'turn-2' })).toBeUndefined();
        expect(agentChatDockedPlan(undefined)).toBeUndefined();
    });
});

describe('agentChatItemStatusLabel', () => {
    it('names and tones every outcome a work row can settle in', () => {
        expect(agentChatItemStatusLabel('failed')).toBe('Failed');
        expect(agentChatItemStatusTone('failed')).toBe('danger');
        expect(agentChatItemStatusLabel('declined')).toBe('Declined');
        expect(agentChatItemStatusTone('declined')).toBe('warning');
        expect(agentChatItemStatusLabel('interrupted')).toBe('Interrupted');
        expect(agentChatItemStatusTone('interrupted')).toBe('warning');
    });
});

describe('agentChatNoticeMessage', () => {
    it('owns the copy for known notices and keeps provider text after it', () => {
        expect(agentChatNoticeMessage({ id: 'n', type: 'notice', kind: 'compacted' })).toBe(
            'Context compacted',
        );
        expect(
            agentChatNoticeMessage({
                id: 'n',
                type: 'notice',
                kind: 'retrying',
                message: 'rate limit',
            }),
        ).toBe('Retrying: rate limit');
        expect(
            agentChatNoticeMessage({
                id: 'n',
                type: 'notice',
                kind: 'retrying',
                retry: { cause: 'connection', attempt: 2, maxAttempts: 10 },
                message: 'stream disconnected',
            }),
        ).toBe('Connection lost, retrying (2/10)\nstream disconnected');
        expect(
            agentChatNoticeMessage({
                id: 'n',
                type: 'notice',
                kind: 'retrying',
                retry: { cause: 'overloaded', attempt: 1 },
            }),
        ).toBe('API overloaded, retrying (attempt 1)');
        expect(
            agentChatNoticeMessage({
                id: 'n',
                type: 'notice',
                kind: 'retrying',
                retry: { cause: 'connection', attempt: 2, maxAttempts: 10, resolved: true },
                message: 'stream disconnected',
            }),
        ).toBe('Recovered after 2 retries');
        expect(
            agentChatNoticeMessage({
                id: 'n',
                type: 'notice',
                kind: 'retrying',
                retry: { cause: 'other', attempt: 1, resolved: true },
            }),
        ).toBe('Recovered after 1 retry');
        expect(
            agentChatNoticeMessage({
                id: 'n',
                type: 'notice',
                kind: 'retrying',
                retry: { cause: 'other', resolved: true },
            }),
        ).toBe('Recovered');
        expect(agentChatNoticeMessage({ id: 'n', type: 'notice', kind: 'error' })).toBe(
            'The Agent reported an error',
        );
    });
});

describe('isAgentChatItemVisible', () => {
    it('hides a thought or a finished reply with no words, but keeps a reply still streaming', () => {
        expect(
            isAgentChatItemVisible({ id: 'r', type: 'reasoning', text: ' \n', streaming: true }),
        ).toBe(false);
        expect(
            isAgentChatItemVisible({ id: 'r', type: 'reasoning', text: 'Plan', streaming: false }),
        ).toBe(true);
        expect(
            isAgentChatItemVisible({ id: 'a', type: 'agentMessage', text: '\n', streaming: false }),
        ).toBe(false);
        expect(
            isAgentChatItemVisible({ id: 'a', type: 'agentMessage', text: '', streaming: true }),
        ).toBe(true);
        expect(
            isAgentChatItemVisible({
                id: 'a',
                type: 'agentMessage',
                text: 'Done',
                streaming: false,
            }),
        ).toBe(true);
    });

    it('keeps an image-only user message and drops an empty one', () => {
        expect(
            isAgentChatItemVisible({ id: 'u', type: 'userMessage', text: '', images: [{}] }),
        ).toBe(true);
        expect(isAgentChatItemVisible({ id: 'u', type: 'userMessage', text: '' })).toBe(false);
    });
});

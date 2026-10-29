import { describe, expect, it } from 'vitest';

import {
    AGENT_CHAT_EXIT_PLAN_TOOL,
    agentApprovalAlwaysAllowLabel,
    agentChatAnsweredNotice,
    agentChatApprovalChoices,
    agentChatImplementablePlanId,
    agentChatProposedPlanRequest,
    agentChatRequestTitle,
    agentChatWaitingText,
    isAgentChatApprovalRequest,
} from '../agent-chat-approval';
import type { AgentChatItem } from '../agent-chat-contract';

const labels = (request: Parameters<typeof agentChatApprovalChoices>[0]) =>
    agentChatApprovalChoices(request).map((choice) => choice.label);

describe('agentChatApprovalChoices', () => {
    it('names each button by the outcome the request type gets', () => {
        expect(labels({ id: 'r', kind: 'command', command: 'make' })).toEqual([
            'Run',
            'Always Allow in This Chat',
            'Deny',
        ]);
        expect(labels({ id: 'r', kind: 'fileChange' })).toEqual([
            'Apply Changes',
            'Always Allow in This Chat',
            'Deny',
        ]);
        expect(labels({ id: 'r', kind: 'tool', name: 'WebFetch' })).toEqual([
            'Allow',
            'Always Allow in This Chat',
            'Deny',
        ]);
    });

    it('adds an Always Allow button naming the command prefix Codex proposes', () => {
        const request = {
            id: 'r',
            kind: 'command' as const,
            command: 'git push origin main',
            alwaysAllowPrefix: 'git push',
            decisions: ['accept' as const, 'acceptAlways' as const, 'decline' as const],
        };
        expect(labels(request)).toEqual(['Run', 'Always Allow git push', 'Deny']);
        expect(agentChatApprovalChoices(request)[1]?.hint).toContain('every Codex Chat');
        // A long prefix is cut in the label and kept whole in the hint.
        const long = 'cargo run --release --manifest-path crates/tool/Cargo.toml';
        const [, choice] = agentChatApprovalChoices({ ...request, alwaysAllowPrefix: long });
        expect(choice.label.endsWith('…')).toBe(true);
        expect(choice.hint).toContain(long);
        // Without `acceptAlways` in the provider's list, or without a prefix, the button is absent.
        expect(labels({ ...request, decisions: ['accept', 'decline'] })).toEqual(['Run', 'Deny']);
        expect(labels({ id: 'r', kind: 'command', decisions: ['accept', 'acceptAlways'] })).toEqual(
            ['Run'],
        );
    });

    it('allows network access instead of running, and keeps planning instead of denying a plan', () => {
        expect(labels({ id: 'r', kind: 'command', networkHost: 'example.com' })[0]).toBe('Allow');
        expect(labels({ id: 'r', kind: 'tool', name: 'ExitPlanMode' })).toEqual([
            'Start Building',
            'Always Allow in This Chat',
            'Keep Planning',
        ]);
    });

    it('offers only the decisions the provider lists, in a fixed order', () => {
        expect(
            agentChatApprovalChoices({
                id: 'r',
                kind: 'fileChange',
                decisions: ['decline', 'cancel', 'accept'],
            }),
        ).toEqual([
            { decision: 'accept', label: 'Apply Changes' },
            { decision: 'decline', label: 'Deny' },
        ]);
    });
});

describe('agentChatRequestTitle', () => {
    it('asks about a generic tool by name', () => {
        expect(
            agentChatRequestTitle(
                { id: 'r', kind: 'tool', name: 'WebFetch', decisions: ['accept'] },
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

    it('asks about commands, file changes, network access, and the plan Claude Code proposes', () => {
        expect(agentChatRequestTitle({ id: 'r', kind: 'command' }, 'Codex')).toBe(
            'Run this command?',
        );
        expect(
            agentChatRequestTitle({ id: 'r', kind: 'command', networkHost: 'a.dev' }, 'Codex'),
        ).toBe('Allow network access to a.dev?');
        expect(agentChatRequestTitle({ id: 'r', kind: 'fileChange' }, 'Codex')).toBe(
            'Apply these file changes?',
        );
        expect(
            agentChatRequestTitle({ id: 'r', kind: 'tool', name: 'ExitPlanMode' }, 'Claude Code'),
        ).toBe('Start with this plan?');
    });
});

describe('agentChatWaitingText', () => {
    it('tells an approval from a question', () => {
        expect(agentChatWaitingText([{ id: 'r', kind: 'fileChange' }])).toBe(
            'Waiting for your approval',
        );
        expect(agentChatWaitingText([{ id: 'r', kind: 'question', questions: [] }])).toBe(
            'Waiting for your answer',
        );
    });
});

describe('shared approval labels', () => {
    it('scopes the standing approval to a Chat or a Session with the same wording', () => {
        expect(agentApprovalAlwaysAllowLabel('Chat')).toBe('Always Allow in This Chat');
        expect(agentApprovalAlwaysAllowLabel('Session')).toBe('Always Allow in This Session');
    });
});

describe('agentChatAnsweredNotice', () => {
    it('records the answers to a question, a digest labelled by header plus each full question, and skips unanswered questions', () => {
        const question = (id: string, header: string) => ({
            id,
            header,
            question: `${id}?`,
            options: [],
            allowsOther: true,
        });
        expect(
            agentChatAnsweredNotice(
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
            answers: [
                { question: 'color?', answer: 'Blue' },
                { question: 'size?', answer: 'S, M' },
                { question: 'skip?', answer: '' },
            ],
        });
        expect(
            agentChatAnsweredNotice({ id: 'a', kind: 'fileChange' }, undefined, {}),
        ).toBeUndefined();
        expect(
            agentChatAnsweredNotice(
                { id: 'q', kind: 'question', questions: [question('x', 'X')] },
                undefined,
                {},
            ),
        ).toBeUndefined();
    });
});

const user = (id: string): AgentChatItem => ({ id, type: 'userMessage', text: 'go' });
const plan = (id: string, isStreaming = false): AgentChatItem => ({
    id,
    type: 'agentMessage',
    text: '1. Read',
    streaming: isStreaming,
    proposedPlan: true,
});
const reply = (id: string): AgentChatItem => ({
    id,
    type: 'agentMessage',
    text: 'Hi',
    streaming: false,
});

describe('agentChatImplementablePlanId', () => {
    it('returns the latest finished proposed plan while plan mode is on and idle', () => {
        expect(
            agentChatImplementablePlanId({
                planMode: true,
                items: [user('u1'), plan('p1'), reply('a1'), user('u2'), plan('p2'), reply('a2')],
            }),
        ).toBe('p2');
    });

    it('is absent once the user spoke after the plan', () => {
        expect(
            agentChatImplementablePlanId({ planMode: true, items: [plan('p1'), user('u2')] }),
        ).toBeUndefined();
    });

    it.each([
        ['plan mode is off', { planMode: false, items: [plan('p1')] }],
        ['plan mode is unknown', { items: [plan('p1')] }],
        ['a turn is running', { planMode: true, activeTurnId: 't', items: [plan('p1')] }],
        ['the plan is still streaming', { planMode: true, items: [plan('p1', true)] }],
        ['the reply is not a plan', { planMode: true, items: [user('u'), reply('a')] }],
    ])('is absent when %s', (_name, snapshot) => {
        expect(agentChatImplementablePlanId(snapshot)).toBeUndefined();
    });
});

describe('agentChatProposedPlanRequest', () => {
    it('reads as the Claude plan approval card with only Start Building and Keep Planning', () => {
        const request = agentChatProposedPlanRequest('p1');
        expect(request).toMatchObject({ kind: 'tool', name: AGENT_CHAT_EXIT_PLAN_TOOL });
        if (!isAgentChatApprovalRequest(request)) throw new Error('expected an approval');
        expect(agentChatRequestTitle(request, 'Codex')).toBe('Start with this plan?');
        expect(agentChatApprovalChoices(request).map((choice) => choice.label)).toEqual([
            'Start Building',
            'Keep Planning',
        ]);
    });
});

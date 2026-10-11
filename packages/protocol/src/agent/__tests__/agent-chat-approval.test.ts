import { describe, expect, it } from 'vitest';

import {
    AGENT_APPROVAL_ALLOW_LABEL,
    AGENT_APPROVAL_DENY_LABEL,
    agentApprovalAlwaysAllowLabel,
    agentChatApprovalChoices,
    agentChatRequestTitle,
    agentChatWaitingText,
} from '../agent-chat-approval';

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
        expect(AGENT_APPROVAL_ALLOW_LABEL).toBe('Allow');
        expect(AGENT_APPROVAL_DENY_LABEL).toBe('Deny');
    });
});

import { describe, expect, it } from 'vitest';

import {
    agentChatGoalModeDraft,
    agentChatLeadingInvocation,
    agentChatSkillDiscoveryNotice,
    isAgentChatGoalAction,
    isAgentChatGoalOffered,
    withAgentChatBuiltInActions,
} from '../agent-chat-slash-commands';

describe('Agent Chat slash commands', () => {
    it('explains missing skills until discovery answers', () => {
        expect(agentChatSkillDiscoveryNotice({ isAgentRunning: false, isLoading: false })).toEqual({
            text: 'Skills appear once the Agent is running',
            isLoading: false,
        });
        expect(agentChatSkillDiscoveryNotice({ isAgentRunning: true, isLoading: true })).toEqual({
            text: 'Loading skills…',
            isLoading: true,
        });
        expect(
            agentChatSkillDiscoveryNotice({ isAgentRunning: true, isLoading: false }),
        ).toBeUndefined();
    });
});

describe('agentChatLeadingInvocation', () => {
    it('splits the skill or command a message starts with from what follows', () => {
        expect(agentChatLeadingInvocation('$status-report')).toEqual({
            invocation: '$status-report',
            rest: '',
        });
        expect(agentChatLeadingInvocation('/review the open PR')).toEqual({
            invocation: '/review',
            rest: ' the open PR',
        });
        expect(agentChatLeadingInvocation('/plugin:skill\nnext line')).toEqual({
            invocation: '/plugin:skill',
            rest: '\nnext line',
        });
    });

    it('leaves prices, paths, and mid-sentence names as plain text', () => {
        expect(agentChatLeadingInvocation('$5 is the price')).toBeUndefined();
        expect(agentChatLeadingInvocation('/usr/bin is missing')).toBeUndefined();
        expect(agentChatLeadingInvocation('run $status-report')).toBeUndefined();
    });
});

describe('Goal mode', () => {
    it('is offered only when the provider reports a native goal command', () => {
        expect(isAgentChatGoalOffered([{ name: 'goal', goal: true }])).toBe(true);
        // A Claude Code custom /goal runs as an ordinary command.
        expect(isAgentChatGoalOffered([{ name: 'goal' }])).toBe(false);
        expect(isAgentChatGoalOffered([{ name: 'compact' }])).toBe(false);
        expect(isAgentChatGoalOffered(undefined)).toBe(false);
    });

    it('keeps the typed text as the goal and drops a /goal the user already typed', () => {
        expect(agentChatGoalModeDraft('')).toBe('');
        expect(agentChatGoalModeDraft('ship the picker')).toBe('ship the picker');
        expect(agentChatGoalModeDraft('/goal ship it')).toBe('ship it');
        expect(agentChatGoalModeDraft('  /goal')).toBe('');
        expect(agentChatGoalModeDraft('/goals are fun')).toBe('/goals are fun');
    });

    it('enters Goal mode from the /goal command row only', () => {
        expect(
            isAgentChatGoalAction({
                invocation: '/goal',
                kind: 'command',
                requiresArguments: true,
                source: 'builtIn',
            }),
        ).toBe(true);
        expect(
            isAgentChatGoalAction({
                invocation: '$goal',
                kind: 'skill',
                requiresArguments: false,
                source: 'project',
            }),
        ).toBe(false);
        expect(
            isAgentChatGoalAction({
                invocation: '/compact',
                kind: 'command',
                requiresArguments: false,
                source: 'builtIn',
            }),
        ).toBe(false);
    });

    it('offers /new-session first for every provider, replacing a provider command of that name', () => {
        const review = {
            invocation: '/review',
            kind: 'command',
            requiresArguments: false,
            source: 'builtIn',
        } as const;
        const actions = withAgentChatBuiltInActions([
            review,
            { ...review, invocation: '/new-session' },
        ]);
        expect(actions.map(({ invocation }) => invocation)).toEqual(['/new-session', '/review']);
        expect(actions[0]).toMatchObject({
            description: 'Hand the next task to a new Session and stop here',
            argumentHint: '[next task]',
        });
    });
});

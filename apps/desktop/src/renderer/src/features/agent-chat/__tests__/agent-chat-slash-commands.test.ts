import type { AgentAction } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatDraftMatches,
    agentChatGoalModeDraft,
    agentChatLeadingInvocation,
    agentChatMenuActions,
    agentChatMenuGroupHeading,
    agentChatSkillDiscoveryNotice,
    completeAgentChatAction,
    filterAgentChatActions,
    isAgentChatGoalAction,
    isAgentChatGoalOffered,
} from '../agent-chat-slash-commands';

const commands = [
    { name: 'compact', argumentHint: '<instructions>' },
    { name: 'review' },
    { name: 'security-review' },
];

const skill = (invocation: string, description?: string): AgentAction => ({
    invocation,
    kind: 'skill',
    ...(description && { description }),
    requiresArguments: false,
    source: 'project',
});

describe('Agent Chat slash commands', () => {
    it('offers the provider commands, then discovered skills, but never picker-only commands', () => {
        const actions = agentChatMenuActions(commands, [
            skill('$commit', 'Commit staged work'),
            skill('/review'),
            { ...skill('/model'), kind: 'command', source: 'builtIn' },
        ]);
        expect(actions.map((action) => action.invocation)).toEqual([
            '/compact',
            '/review',
            '/security-review',
            '$commit',
        ]);
        expect(actions[0]).toMatchObject({ kind: 'command', argumentHint: '<instructions>' });
    });

    it('ranks name matches like the Agent Commands & Skills picker within each group', () => {
        const actions = agentChatMenuActions(commands, [skill('$commit', 'Review and commit')]);
        expect(filterAgentChatActions(actions, 'rev').map((action) => action.invocation)).toEqual([
            '/review',
            '/security-review',
            '$commit',
        ]);
        // The skill ranks first, but commands are drawn (and walked) above skills.
        expect(filterAgentChatActions(actions, 'com').map((action) => action.invocation)).toEqual([
            '/compact',
            '$commit',
        ]);
        // A `$` draft asks for a skill, so skills lead.
        expect(
            filterAgentChatActions(actions, 'com', '$').map((action) => action.invocation),
        ).toEqual(['$commit', '/compact']);
        expect(filterAgentChatActions(actions, '')).toHaveLength(4);
        expect(filterAgentChatActions(actions, 'zzz')).toEqual([]);
    });

    it('matches only a bare invocation, led by the group its sigil names', () => {
        const actions = agentChatMenuActions(commands, [skill('$commit', 'Review and commit')]);
        expect(agentChatDraftMatches(actions, '/com').map((action) => action.invocation)).toEqual([
            '/compact',
            '$commit',
        ]);
        expect(agentChatDraftMatches(actions, '$com').map((action) => action.invocation)).toEqual([
            '$commit',
            '/compact',
        ]);
        expect(agentChatDraftMatches(actions, '/com and more')).toEqual([]);
        expect(agentChatDraftMatches(actions, 'plain text')).toEqual([]);
    });

    it('heads each group once, where it starts', () => {
        const actions = filterAgentChatActions(
            agentChatMenuActions(commands, [skill('$commit')]),
            '',
        );
        expect(actions.map((_, index) => agentChatMenuGroupHeading(actions, index))).toEqual([
            'Commands',
            undefined,
            undefined,
            'Skills',
        ]);
        expect(agentChatMenuGroupHeading([skill('$commit')], 0)).toBe('Skills');
    });

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

    it('leaves room for arguments when a command takes them and after every skill', () => {
        expect(agentChatMenuActions(commands, []).map(completeAgentChatAction)).toEqual([
            '/compact ',
            '/review',
            '/security-review',
        ]);
        expect(completeAgentChatAction(skill('$commit'))).toBe('$commit ');
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
        expect(isAgentChatGoalAction(skill('$goal'))).toBe(false);
        expect(
            isAgentChatGoalAction({
                invocation: '/compact',
                kind: 'command',
                requiresArguments: false,
                source: 'builtIn',
            }),
        ).toBe(false);
    });
});

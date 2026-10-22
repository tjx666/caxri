import { describe, expect, it } from 'vitest';

import type { AgentAction } from '../agent-action-contract.js';
import {
    agentChatDraftMatches,
    agentChatMenuActions,
    agentChatMenuGroupHeading,
    agentChatRecentMenuActions,
    agentChatSlashQuery,
    completeAgentChatAction,
    filterAgentChatActions,
    parseAgentChatCommand,
} from '../agent-chat-commands.js';

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

describe('Agent Chat commands', () => {
    it('suggests only while the draft is a bare command name', () => {
        expect(agentChatSlashQuery('/')).toBe('');
        expect(agentChatSlashQuery('/rev')).toBe('rev');
        expect(agentChatSlashQuery('$com')).toBe('com');
        expect(agentChatSlashQuery('/compact now')).toBeUndefined();
        expect(agentChatSlashQuery('hello /rev')).toBeUndefined();
    });

    it('runs a listed command with its arguments and sends anything else as a message', () => {
        expect(parseAgentChatCommand('/compact', commands)).toEqual({ name: 'compact' });
        expect(parseAgentChatCommand('/compact  keep the plan\n', commands)).toEqual({
            name: 'compact',
            arguments: 'keep the plan',
        });
        expect(parseAgentChatCommand('/model gpt', commands)).toBeUndefined();
        expect(parseAgentChatCommand('/compact', undefined)).toBeUndefined();
        expect(parseAgentChatCommand('please /compact', commands)).toBeUndefined();
    });
});

describe('Agent Chat composer menu', () => {
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

    it('leads a bare sigil with the recently used rows it still offers, under their own heading', () => {
        const actions = agentChatMenuActions(commands, [skill('$commit')]);
        // Most recent first; `/gone` is no longer offered.
        const recent = ['$commit', '/gone', '/review'];
        const matches = agentChatDraftMatches(actions, '/', recent);
        expect(matches.map((action) => action.invocation)).toEqual([
            '$commit',
            '/review',
            '/compact',
            '/security-review',
        ]);
        const recentCount = agentChatRecentMenuActions(actions, '/', recent).length;
        expect(recentCount).toBe(2);
        expect(
            matches.map((_, index) => agentChatMenuGroupHeading(matches, index, recentCount)),
        ).toEqual(['Recent', undefined, 'Commands', undefined]);
        // A `$` draft keeps the same recents ahead of its skills-first order.
        expect(
            agentChatDraftMatches(actions, '$', ['/review']).map((action) => action.invocation),
        ).toEqual(['/review', '$commit', '/compact', '/security-review']);
    });

    it('ranks a typed name by the match alone, ignoring recents', () => {
        const actions = agentChatMenuActions(commands, [skill('$commit', 'Review and commit')]);
        expect(agentChatRecentMenuActions(actions, '/rev', ['$commit'])).toEqual([]);
        expect(
            agentChatDraftMatches(actions, '/rev', ['$commit']).map((action) => action.invocation),
        ).toEqual(['/review', '/security-review', '$commit']);
        expect(agentChatDraftMatches(actions, 'plain', ['$commit'])).toEqual([]);
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

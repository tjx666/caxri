import type { AgentAction } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatLeadingInvocation,
    agentChatMenuActions,
    agentChatSlashQuery,
    completeAgentChatAction,
    filterAgentChatActions,
    parseAgentChatCommand,
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
    it('suggests only while the draft is a bare command name', () => {
        expect(agentChatSlashQuery('/')).toBe('');
        expect(agentChatSlashQuery('/rev')).toBe('rev');
        expect(agentChatSlashQuery('$com')).toBe('com');
        expect(agentChatSlashQuery('/compact now')).toBeUndefined();
        expect(agentChatSlashQuery('hello /rev')).toBeUndefined();
    });

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

    it('ranks name matches like the Agent Commands & Skills picker', () => {
        const actions = agentChatMenuActions(commands, [skill('$commit', 'Review and commit')]);
        expect(filterAgentChatActions(actions, 'rev').map((action) => action.invocation)).toEqual([
            '/review',
            '/security-review',
            '$commit',
        ]);
        expect(filterAgentChatActions(actions, 'com').map((action) => action.invocation)).toEqual([
            '$commit',
            '/compact',
        ]);
        expect(filterAgentChatActions(actions, '')).toHaveLength(4);
        expect(filterAgentChatActions(actions, 'zzz')).toEqual([]);
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

import { describe, expect, it } from 'vitest';

import {
    agentChatSlashQuery,
    completeAgentChatCommand,
    filterAgentChatCommands,
    parseAgentChatCommand,
} from '../agent-chat-slash-commands';

const commands = [
    { name: 'compact', argumentHint: '<instructions>' },
    { name: 'review' },
    { name: 'security-review' },
];

describe('Agent Chat slash commands', () => {
    it('suggests only while the draft is a bare command name', () => {
        expect(agentChatSlashQuery('/')).toBe('');
        expect(agentChatSlashQuery('/rev')).toBe('rev');
        expect(agentChatSlashQuery('/compact now')).toBeUndefined();
        expect(agentChatSlashQuery('hello /rev')).toBeUndefined();
    });

    it('ranks prefix matches before substring matches', () => {
        expect(filterAgentChatCommands(commands, 'rev').map((command) => command.name)).toEqual([
            'review',
            'security-review',
        ]);
        expect(filterAgentChatCommands(commands, '')).toHaveLength(3);
        expect(filterAgentChatCommands(commands, 'zzz')).toEqual([]);
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

    it('leaves room for arguments only when the command takes them', () => {
        expect(completeAgentChatCommand(commands[0])).toBe('/compact ');
        expect(completeAgentChatCommand(commands[1])).toBe('/review');
    });
});

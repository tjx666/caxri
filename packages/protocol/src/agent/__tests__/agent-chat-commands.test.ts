import { describe, expect, it } from 'vitest';

import { agentChatSlashQuery, parseAgentChatCommand } from '../agent-chat-commands.js';

const commands = [
    { name: 'compact', argumentHint: '<instructions>' },
    { name: 'review' },
    { name: 'security-review' },
];

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

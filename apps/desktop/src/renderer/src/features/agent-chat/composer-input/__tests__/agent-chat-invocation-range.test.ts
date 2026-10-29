import { describe, expect, it } from 'vitest';

import { agentChatInvocationRange } from '../chips/agent-chat-invocation-range';

const known = new Set(['/compact', '/review', '$commit']);

describe('agentChatInvocationRange', () => {
    it('recognizes a known command followed by text', () => {
        expect(agentChatInvocationRange('/compact now', known)).toEqual({
            from: 0,
            invocation: '/compact',
            to: 8,
        });
    });

    it('recognizes a known skill with the caret elsewhere', () => {
        expect(agentChatInvocationRange('$commit the fix', known, 15)).toEqual({
            from: 0,
            invocation: '$commit',
            to: 7,
        });
    });

    it('leaves an unknown command, a path, and a price as plain text', () => {
        expect(agentChatInvocationRange('/foo bar', known)).toBeUndefined();
        expect(agentChatInvocationRange('/usr/bin/env', known)).toBeUndefined();
        expect(agentChatInvocationRange('$5 each', known)).toBeUndefined();
    });

    it('only recognizes the sigil the menu offers', () => {
        expect(agentChatInvocationRange('$compact x', known)).toBeUndefined();
    });

    it('ignores a token that is not at the start', () => {
        expect(agentChatInvocationRange('run /compact', known)).toBeUndefined();
        expect(agentChatInvocationRange(' /compact', known)).toBeUndefined();
    });

    it('keeps a token editable while the caret touches it at the end of the draft', () => {
        expect(agentChatInvocationRange('/compact', known, 8)).toBeUndefined();
        expect(agentChatInvocationRange('/compact', known, 3)).toBeUndefined();
    });

    it('shows the chip for a bare token once the caret or focus leaves it', () => {
        expect(agentChatInvocationRange('/compact', known)).toMatchObject({ to: 8 });
        expect(agentChatInvocationRange('/compact ', known, 9)).toMatchObject({ to: 8 });
    });

    it('does not recognize anything without known invocations', () => {
        expect(agentChatInvocationRange('/compact x', new Set())).toBeUndefined();
    });
});

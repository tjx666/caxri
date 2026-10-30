import { describe, expect, it } from 'vitest';

import {
    agentChatCommandFinalFocus,
    canRunAgentChatComposerCommand,
    registerAgentChatComposerCommand,
    runAgentChatComposerCommand,
    subscribeAgentChatComposerCommands,
} from '../agent-chat-composer-commands';

describe('Agent Chat composer commands', () => {
    it('tells subscribers when a control registers or leaves, until they unsubscribe', () => {
        let changes = 0;
        const unsubscribe = subscribeAgentChatComposerCommands(() => (changes += 1));
        const unregister = registerAgentChatComposerCommand('chat-1', 'openSideChat', () => {});
        expect(changes).toBe(1);
        unregister();
        expect(changes).toBe(2);
        unsubscribe();
        registerAgentChatComposerCommand('chat-1', 'openSideChat', () => {})();
        expect(changes).toBe(2);
    });

    it('reaches only the control the Chat registered, and only while it stays registered', () => {
        const ran: string[] = [];
        const unregister = registerAgentChatComposerCommand('chat-1', 'changeModel', () =>
            ran.push('model'),
        );

        expect(canRunAgentChatComposerCommand('chat-1', 'changeModel')).toBe(true);
        expect(canRunAgentChatComposerCommand('chat-1', 'togglePlanMode')).toBe(false);
        expect(canRunAgentChatComposerCommand('chat-2', 'changeModel')).toBe(false);
        expect(canRunAgentChatComposerCommand(undefined, 'changeModel')).toBe(false);

        runAgentChatComposerCommand('chat-1', 'changeModel');
        runAgentChatComposerCommand('chat-1', 'togglePlanMode');
        runAgentChatComposerCommand('chat-2', 'changeModel');
        expect(ran).toEqual(['model']);

        unregister();
        expect(canRunAgentChatComposerCommand('chat-1', 'changeModel')).toBe(false);
        runAgentChatComposerCommand('chat-1', 'changeModel');
        expect(ran).toEqual(['model']);
    });

    it('keeps a remounted control registered when the previous one unregisters late', () => {
        const ran: string[] = [];
        const unregisterOld = registerAgentChatComposerCommand('chat-1', 'togglePlanMode', () =>
            ran.push('old'),
        );
        const unregisterNew = registerAgentChatComposerCommand('chat-1', 'togglePlanMode', () =>
            ran.push('new'),
        );

        unregisterOld();
        runAgentChatComposerCommand('chat-1', 'togglePlanMode');

        expect(ran).toEqual(['new']);
        unregisterNew();
        expect(canRunAgentChatComposerCommand('chat-1', 'togglePlanMode')).toBe(false);
    });

    it('returns a command-opened menu to the element focused when the command ran', () => {
        const ownerDocument: { body?: unknown } = {};
        const element = (isConnected: boolean) => ({
            focus: () => {},
            isConnected,
            ownerDocument,
        });
        const body = element(true);
        ownerDocument.body = body;
        const input = element(true);

        expect(agentChatCommandFinalFocus(input as unknown as Element)).toBe(input);
        // Run from the command palette, whose input is gone by the time the menu closes.
        expect(agentChatCommandFinalFocus(element(false) as unknown as Element)).toBe(true);
        expect(agentChatCommandFinalFocus(body as unknown as Element)).toBe(true);
        expect(agentChatCommandFinalFocus(null)).toBe(true);
    });
});

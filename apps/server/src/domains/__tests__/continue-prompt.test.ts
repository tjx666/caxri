import { describe, expect, it, vi } from 'vitest';

import { sendContinuePrompt } from '../continue-prompt';

function targets(launchId: string | undefined) {
    return {
        agentChat: { send: vi.fn(() => Promise.resolve()) },
        terminals: {
            agentLaunchId: vi.fn(() => launchId),
            submitAgentExact: vi.fn(() => Promise.resolve({} as never)),
        },
    };
}

describe('sendContinuePrompt', () => {
    it('sends a Chat Agent a turn that is not user input, so a delegated child keeps its task', async () => {
        const target = targets('launch-1');
        await sendContinuePrompt(
            target,
            { id: 'chat-1', surface: 'chat' },
            'session-1',
            'Continue',
        );
        expect(target.agentChat.send).toHaveBeenCalledWith(
            'chat-1',
            { text: 'Continue' },
            'queue',
            'delegation',
        );
        expect(target.terminals.submitAgentExact).not.toHaveBeenCalled();
    });

    it("submits to a PTY Agent's current launch, not as user input", async () => {
        const target = targets('launch-1');
        await sendContinuePrompt(target, { id: 'pty-1' }, 'session-1', 'Continue');
        expect(target.terminals.submitAgentExact).toHaveBeenCalledWith(
            'pty-1',
            'session-1',
            'launch-1',
            'Continue',
            undefined,
            'delegation',
        );
        expect(target.agentChat.send).not.toHaveBeenCalled();
    });

    it('skips a PTY Agent that has no current launch', async () => {
        const target = targets(undefined);
        await sendContinuePrompt(target, { id: 'pty-1' }, 'session-1', 'Continue');
        expect(target.terminals.submitAgentExact).not.toHaveBeenCalled();
    });
});

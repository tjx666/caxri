import { describe, expect, it } from 'vitest';

import { agentChatHostCapabilities } from '../agent-chat-host';

describe('agentChatHostCapabilities', () => {
    it('offers every host-gated Chat action in the Workbench', () => {
        expect(agentChatHostCapabilities('workbench')).toEqual({
            canFork: true,
            canOpenBesideChat: true,
            canSaveProjectDefault: true,
            canOpenContext: true,
            canContinueInAgent: true,
        });
    });

    /**
     * Main's Caxri Bot policy refuses Project writes and the window has no Workbench, so offering either action there
     * only ends in a failure toast.
     */
    it('offers no fork, continuation, Project default, or Context tab in the Caxri Bot window', () => {
        expect(agentChatHostCapabilities('bot')).toMatchObject({
            canFork: false,
            canContinueInAgent: false,
            canSaveProjectDefault: false,
            canOpenContext: false,
        });
    });

    /**
     * The window mounts no pane layout, so a task or turn-review tab opened there would be invisible yet persisted into
     * the layout of Caxri Bot's Session (issue caxri#1719).
     */
    it('opens nothing beside the Chat in the Caxri Bot window', () => {
        expect(agentChatHostCapabilities('bot').canOpenBesideChat).toBe(false);
    });
});

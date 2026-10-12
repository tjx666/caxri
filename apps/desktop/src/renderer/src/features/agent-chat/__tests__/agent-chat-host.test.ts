import { describe, expect, it } from 'vitest';

import { agentChatHostCapabilities } from '../agent-chat-host';

describe('agentChatHostCapabilities', () => {
    it('offers every host-gated Chat action in the Workbench', () => {
        expect(agentChatHostCapabilities('workbench')).toEqual({
            canFork: true,
            canOpenBesideChat: true,
            canSaveProjectDefault: true,
            canOpenContext: true,
        });
    });

    /**
     * Main's Commander policy refuses Project writes and the window has no Workbench, so offering either action there
     * only ends in a failure toast.
     */
    it('offers no fork, Project default, or Context tab in the Agent Commander window', () => {
        expect(agentChatHostCapabilities('commander')).toMatchObject({
            canFork: false,
            canSaveProjectDefault: false,
            canOpenContext: false,
        });
    });

    /**
     * The window mounts no pane layout, so a task or turn-review tab opened there would be invisible yet persisted into
     * the Commander Session's layout (issue caxri#1719).
     */
    it('opens nothing beside the Chat in the Agent Commander window', () => {
        expect(agentChatHostCapabilities('commander').canOpenBesideChat).toBe(false);
    });
});

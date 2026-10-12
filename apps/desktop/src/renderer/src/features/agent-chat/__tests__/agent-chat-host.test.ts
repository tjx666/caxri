import { describe, expect, it } from 'vitest';

import { agentChatHostCapabilities } from '../agent-chat-host';

describe('agentChatHostCapabilities', () => {
    it('offers every host-gated Chat action in the Workbench', () => {
        expect(agentChatHostCapabilities('workbench')).toEqual({
            canFork: true,
            canSaveProjectDefault: true,
        });
    });

    /**
     * Main's Commander policy refuses Project writes and the window has no Workbench, so offering either action there
     * only ends in a failure toast.
     */
    it('offers neither fork nor the Project default in the Agent Commander window', () => {
        expect(agentChatHostCapabilities('commander')).toEqual({
            canFork: false,
            canSaveProjectDefault: false,
        });
    });
});

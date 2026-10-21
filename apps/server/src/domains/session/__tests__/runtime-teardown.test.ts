import { describe, expect, it, vi } from 'vitest';

import { createSessionRuntimeForgetter } from '../runtime-teardown';

describe('createSessionRuntimeForgetter', () => {
    it('retires the pull request settlement state of a deleted Session', () => {
        const forgetSession = vi.fn();
        const forget = createSessionRuntimeForgetter({
            agentChat: { closeSession: vi.fn(() => Promise.resolve()) },
            agentRuntime: {
                automaticNaming: { forgetSession: vi.fn() },
                coordinator: { forgetSession: vi.fn() },
                revokeAutoAllow: vi.fn(),
                sessionRenames: { forgetSession: vi.fn() },
            },
            settlementWiring: { forgetSession },
            terminalRestores: { forget: vi.fn() },
            terminals: { terminateSession: vi.fn() },
            terminalSuspension: { forgetSession: vi.fn() },
            transcripts: { forgetSession: vi.fn() },
        });

        forget('s1');

        expect(forgetSession).toHaveBeenCalledWith('s1');
    });
});

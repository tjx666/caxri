import { describe, expect, it, vi } from 'vitest';

import { sendAgentInput } from '../agent-input';
import type { RemoteTerminalIdentity, TerminalHostControl } from '../execution-contract';
import { terminal } from './execution-fixtures';

describe('sendAgentInput', () => {
    it('does not send to Terminal Host when authorization is canceled while identity.ready waits', async () => {
        const ready = Promise.withResolvers<void>();
        const cancellation = new AbortController();
        const identity: RemoteTerminalIdentity = {
            agent: { launchId: 'launch-1', processId: 42 },
            generation: 1,
            processId: 43,
            ready: ready.promise,
            record: terminal,
        };
        const request = vi.fn(() => Promise.resolve({ accepted: true }));
        const supervisor = { request } as unknown as TerminalHostControl;
        const inFlight = sendAgentInput(
            supervisor,
            new Map([[terminal.id, identity]]),
            terminal.id,
            'Continue\r',
            cancellation.signal,
        );

        cancellation.abort();
        ready.resolve();
        await expect(inFlight).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(request).not.toHaveBeenCalled();
    });
});

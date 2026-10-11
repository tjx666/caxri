import { describe, expect, it, vi } from 'vitest';

import type { SessionParkingOptions } from '../parking-handlers';
import { createTerminateAllHandler } from '../parking-handlers';

describe('terminal.terminateAll', () => {
    it('closes Chats only after every launch in flight settled, including one that started a Chat meanwhile', async () => {
        const terminals = [{ sessionId: 'session-1' }];
        const terminated = Promise.withResolvers<string[]>();
        const closeSession = vi.fn<(sessionId: string) => Promise<void>>(() => Promise.resolve());
        const handlers = createTerminateAllHandler({
            agentChat: { closeSession },
            commanderRestores: { cancelAll: vi.fn() },
            database: { listTerminals: () => terminals },
            terminalRestores: { cancelAll: vi.fn() },
            terminalSuspension: { terminateAll: () => terminated.promise },
        } as unknown as SessionParkingOptions);

        const terminating = (handlers['terminal.terminateAll'] as () => Promise<null>)();
        // A restart or a switch to Chat that was in flight lands while `terminateAll` waits for it.
        terminals.push({ sessionId: 'session-2' });
        await Promise.resolve();
        expect(closeSession).not.toHaveBeenCalled();
        terminated.resolve([]);
        await terminating;

        expect(closeSession.mock.calls.map(([sessionId]) => sessionId)).toEqual([
            'session-1',
            'session-2',
        ]);
    });
});

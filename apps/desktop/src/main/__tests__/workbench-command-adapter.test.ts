import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { DesktopServerConnection } from '../connection/server-connection';
import { createWorkbenchCommandAdapter } from '../workbench-command-adapter';

function adapter(forwarded: unknown) {
    const raiseOwnerWindow = vi.fn();
    const connection = { forward: vi.fn().mockResolvedValue(forwarded) };
    const commands = createWorkbenchCommandAdapter({
        connection: () => connection as unknown as DesktopServerConnection,
        eventRelay: { recover: vi.fn() },
        handleMainMethod: vi.fn(),
        isWindowAvailable: () => true,
        raiseOwnerWindow,
        serverReady: Promise.resolve(),
    });
    return { commands, raiseOwnerWindow };
}

const select = {
    protocolVersion: CAXRI_PROTOCOL_VERSION,
    id: 'select-1',
    method: 'session.select',
    params: { sessionId: 'session-1' },
};

describe('Workbench command adapter', () => {
    it('raises the owner window when a select was redirected to it', async () => {
        const { commands, raiseOwnerWindow } = adapter({
            id: 'session-1',
            ownerWindowKey: 'win-a',
        });

        await commands.dispatch(select);

        expect(raiseOwnerWindow).toHaveBeenCalledExactlyOnceWith('win-a', 'session.select');
    });

    it('leaves focus alone when the requester owns the Session', async () => {
        const { commands, raiseOwnerWindow } = adapter({ id: 'session-1' });

        await commands.dispatch(select);

        expect(raiseOwnerWindow).not.toHaveBeenCalled();
    });
});

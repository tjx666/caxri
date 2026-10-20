import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ dialog: {}, Menu: {} }));

import { createMainMethodHandler } from '../main-methods';
import type { ProcessExplorerWindowController } from '../process-explorer-window';
import type { DesktopServerConnection } from '../server-connection';
import type { UpdateService } from '../updates';
import { runInRequestWindowKey } from '../window-presence-registry';
import type { createWorkbenchRootAuthority } from '../workbench-root-authority';

function handler(setViewing: (windowKey: string, sessionId: string | null) => void) {
    return createMainMethodHandler({
        getAgentCommander: vi.fn(),
        revealSessionInWorkbench: () => Promise.resolve(),
        openSettingsInWorkbench: () => Promise.resolve(),
        getProcessExplorer: () => ({}) as ProcessExplorerWindowController,
        getRemoteDebugging: () => ({ port: '9223', transport: 'port' }) as const,
        getUserDataPath: () => '/user-data',
        getSupervisor: () => ({ request: vi.fn() }) as unknown as DesktopServerConnection,
        getUpdateService: () => ({}) as UpdateService,
        getWindow: () => {},
        windowPresence: { setViewing },
        workbenchRootAuthority: {} as ReturnType<typeof createWorkbenchRootAuthority>,
    });
}

describe('window.reportViewing', () => {
    it('records the Session for the window that sent the request, never one the Renderer names', async () => {
        const setViewing = vi.fn();
        await expect(
            runInRequestWindowKey('main', () =>
                handler(setViewing)({
                    method: 'window.reportViewing',
                    params: { viewingSessionId: 'session-1' },
                }),
            ),
        ).resolves.toBeNull();
        expect(setViewing).toHaveBeenCalledExactlyOnceWith('main', 'session-1');
    });

    it('refuses a sender that is not a Workbench window', async () => {
        const setViewing = vi.fn();
        await expect(
            handler(setViewing)({
                method: 'window.reportViewing',
                params: { viewingSessionId: null },
            }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(setViewing).not.toHaveBeenCalled();
    });
});

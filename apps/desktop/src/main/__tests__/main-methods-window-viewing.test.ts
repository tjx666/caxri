import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ dialog: {}, Menu: {} }));

import { createMainMethodHandler } from '../main-methods';
import type { ProcessExplorerWindowController } from '../process-explorer-window';
import type { DesktopServerConnection } from '../server-connection';
import type { UpdateService } from '../updates/updates';
import { runInRequestWindowKey } from '../window-presence-registry';
import type { createWorkbenchRootAuthority } from '../workbench-root-authority';

function handler(
    setViewing: (windowKey: string, sessionId: string | null) => void,
    tearOffSession?: NonNullable<Parameters<typeof createMainMethodHandler>[0]['tearOffSession']>,
) {
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
        tearOffSession,
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

describe('window.tearOffSession', () => {
    it('tears off for the window that sent the request and returns the outcome', async () => {
        const tearOffSession = vi.fn().mockResolvedValue({ opened: true });
        await expect(
            runInRequestWindowKey('win-a', () =>
                handler(
                    vi.fn(),
                    tearOffSession,
                )({
                    method: 'window.tearOffSession',
                    params: { sessionId: 'session-1' },
                }),
            ),
        ).resolves.toEqual({ opened: true });
        expect(tearOffSession).toHaveBeenCalledExactlyOnceWith({
            sourceKey: 'win-a',
            sessionId: 'session-1',
        });
    });

    it('refuses a sender that is not a Workbench window', async () => {
        const tearOffSession = vi.fn();
        await expect(
            handler(
                vi.fn(),
                tearOffSession,
            )({
                method: 'window.tearOffSession',
                params: { sessionId: 'session-1' },
            }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(tearOffSession).not.toHaveBeenCalled();
    });
});

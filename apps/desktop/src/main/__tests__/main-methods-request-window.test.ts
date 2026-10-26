import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
    dialog: { showMessageBox: vi.fn() },
    menu: { buildFromTemplate: vi.fn() },
}));
vi.mock('electron', () => ({ dialog: electronMock.dialog, Menu: electronMock.menu }));

import { createMainMethodHandler } from '../main-methods';
import type { ProcessExplorerWindowController } from '../process-explorer-window';
import { runInRequestWindow } from '../request-window';
import type { DesktopServerConnection } from '../server-connection';
import type { UpdateService } from '../updates/updates';
import type { createWorkbenchRootAuthority } from '../workbench-root-authority';

const workbenchWindow = { isDestroyed: () => false } as never;
const commanderWindow = { isDestroyed: () => false } as never;
const parameters = { providerName: 'Claude', removedTurns: 2 };

function handler(getWindow: () => never | undefined = () => workbenchWindow) {
    return createMainMethodHandler({
        getAgentCommander: vi.fn(),
        revealSessionInWorkbench: () => Promise.resolve(),
        openSettingsInWorkbench: () => Promise.resolve(),
        getProcessExplorer: () => ({}) as ProcessExplorerWindowController,
        getRemoteDebugging: () => ({ port: '9223', transport: 'port' }) as const,
        getUserDataPath: () => '/user-data',
        getSupervisor: () => ({ request: vi.fn() }) as unknown as DesktopServerConnection,
        getUpdateService: () => ({}) as UpdateService,
        getWindow,
        workbenchRootAuthority: {} as ReturnType<typeof createWorkbenchRootAuthority>,
    });
}

beforeEach(() => {
    electronMock.dialog.showMessageBox.mockReset();
});

describe('agentChat.confirmRevertFiles window', () => {
    it('attaches the confirmation to the Agent Commander window that sent the request', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
        const handle = handler();

        await expect(
            runInRequestWindow(commanderWindow, () =>
                handle({ method: 'agentChat.confirmRevertFiles', params: parameters }),
            ),
        ).resolves.toEqual({ confirmed: true });
        expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(
            commanderWindow,
            expect.anything(),
        );
    });

    it('falls back to the Workbench window outside a companion request', async () => {
        electronMock.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 });

        await expect(
            handler()({ method: 'agentChat.confirmRevertFiles', params: parameters }),
        ).resolves.toEqual({ confirmed: false });
        expect(electronMock.dialog.showMessageBox).toHaveBeenCalledWith(
            workbenchWindow,
            expect.anything(),
        );
    });

    it('refuses instead of opening a detached prompt when no window is open', async () => {
        await expect(
            handler(() => undefined as never)({
                method: 'agentChat.confirmRevertFiles',
                params: parameters,
            }),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        expect(electronMock.dialog.showMessageBox).not.toHaveBeenCalled();
    });
});

describe('window.fullScreen.get', () => {
    it('reports the fullscreen state of the window that asked', async () => {
        const handle = handler(
            () => ({ isDestroyed: () => false, isFullScreen: () => false }) as never,
        );
        const fullScreenCommander = { isDestroyed: () => false, isFullScreen: () => true } as never;

        await expect(
            runInRequestWindow(fullScreenCommander, () =>
                handle({ method: 'window.fullScreen.get', params: {} }),
            ),
        ).resolves.toEqual({ isFullScreen: true });
        await expect(handle({ method: 'window.fullScreen.get', params: {} })).resolves.toEqual({
            isFullScreen: false,
        });
    });
});

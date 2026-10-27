import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
    clipboard: {},
    dialog: {},
    nativeImage: {},
    shell: {},
}));

import { createMainMethodHandler } from '../main-methods';
import type { ProcessExplorerWindowController } from '../process-explorer-window';
import type { DesktopServerConnection } from '../server-connection';
import type { UpdateService } from '../updates/updates';
import type { createWorkbenchRootAuthority } from '../workbench-root-authority';

function handler(overrides: Partial<Parameters<typeof createMainMethodHandler>[0]> = {}) {
    return createMainMethodHandler({
        getCaxriBot: vi.fn(),
        revealSessionInWorkbench: () => Promise.resolve(),
        openSettingsInWorkbench: () => Promise.resolve(),
        getProcessExplorer: () => ({}) as ProcessExplorerWindowController,
        getRemoteDebugging: () => ({ port: '9223', transport: 'port' }) as const,
        getUserDataPath: () => '/user-data',
        getSupervisor: () => ({}) as DesktopServerConnection,
        getUpdateService: () => ({}) as UpdateService,
        getWindow: () => {},
        workbenchRootAuthority: {} as ReturnType<typeof createWorkbenchRootAuthority>,
        ...overrides,
    });
}

describe('Main GPU recovery methods', () => {
    it('routes the explicit restart action through the Main-owned Safe Mode controller', async () => {
        const restartInGpuSafeMode = vi.fn(() => Promise.resolve());
        const handle = handler({ restartInGpuSafeMode });

        await expect(handle({ method: 'gpu.restartInSafeMode', params: {} })).resolves.toBeNull();
        expect(restartInGpuSafeMode).toHaveBeenCalledOnce();
    });

    it('rejects deterministic fault injection outside E2E and allows it only through the typed method', async () => {
        const injectGpuContextLoss = vi.fn(() => ({
            correlationId: '3fcf11c1-19de-4fdd-8d6c-17ce43c70aae',
        }));
        await expect(
            handler({ injectGpuContextLoss })({
                method: 'gpu.testInjectContextLoss',
                params: {},
            }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });

        await expect(
            handler({ allowGpuTestInjection: true, injectGpuContextLoss })({
                method: 'gpu.testInjectContextLoss',
                params: {},
            }),
        ).resolves.toEqual({
            correlationId: '3fcf11c1-19de-4fdd-8d6c-17ce43c70aae',
        });
    });

    it('routes a hardware re-enable through the controller that clears the circuit marker', async () => {
        const updateArgvConfig = vi.fn(() =>
            Promise.resolve({ hardwareAcceleration: true, remoteDebugging: true }),
        );
        const handle = handler({ updateArgvConfig });

        await expect(
            handle({
                method: 'argv.update',
                params: { changes: { hardwareAcceleration: true } },
            }),
        ).resolves.toEqual({
            value: { hardwareAcceleration: true, remoteDebugging: true },
        });
        expect(updateArgvConfig).toHaveBeenCalledWith({ hardwareAcceleration: true });
    });
});

describe('Main relaunch method', () => {
    it('relaunches after the unsaved-Editor decision continues', async () => {
        const relaunch = vi.fn();
        const decide = vi.fn(() => Promise.resolve('continue' as const));
        const handle = handler({ decideUnsavedEditorsBeforeRelaunch: decide, relaunch });

        await expect(handle({ method: 'app.relaunch', params: {} })).resolves.toBeNull();
        expect(relaunch).toHaveBeenCalledOnce();
    });

    it('aborts the relaunch when the user cancels the unsaved-Editor decision', async () => {
        const relaunch = vi.fn();
        const handle = handler({
            decideUnsavedEditorsBeforeRelaunch: () => Promise.resolve('cancel'),
            relaunch,
        });

        await expect(handle({ method: 'app.relaunch', params: {} })).resolves.toBeNull();
        expect(relaunch).not.toHaveBeenCalled();
    });
});

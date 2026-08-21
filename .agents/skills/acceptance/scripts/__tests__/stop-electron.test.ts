import { describe, expect, it, vi } from 'vitest';

import type { RuntimeState } from '../runtime-state';
import type { StopElectronDependencies } from '../stop-electron';
import { stopElectron } from '../stop-electron';

const runtime: RuntimeState = {
    acceptanceCase: { id: 'stop-case', mode: 'isolated' },
    cdpUrl: 'http://127.0.0.1:9222',
    electronIdentity: 'electron identity',
    electronPid: 222,
    launcherIdentity: 'launcher identity',
    launcherPid: 111,
    ownedUserData: true,
    port: 9222,
    startedAt: '2026-08-21T00:00:00.000Z',
    testRootPath: '/tmp/project',
    testRootPaths: ['/tmp/project'],
    userDataDir: '/tmp/caxri-acceptance-user-stop-case',
};

function dependencies(overrides: Partial<StopElectronDependencies> = {}): StopElectronDependencies {
    return {
        isOwnedLauncher: vi.fn().mockResolvedValue(true),
        isOwnedRuntime: vi.fn().mockResolvedValue(false),
        kill: vi.fn(),
        log: vi.fn(),
        now: () => 0,
        readRuntime: vi.fn().mockResolvedValue(JSON.stringify(runtime)),
        removeOwnedUserData: vi.fn().mockResolvedValue(undefined),
        runtimePath: '/repo/.records/acceptance/runtime.json',
        sleep: vi.fn().mockResolvedValue(undefined),
        unlinkRuntime: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

describe('Acceptance Electron stopper', () => {
    it('is idempotent when no runtime exists and preserves invalid runtime state', async () => {
        const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
        const noRuntime = dependencies({ readRuntime: vi.fn().mockRejectedValue(missing) });
        await expect(stopElectron(noRuntime)).resolves.toBeUndefined();
        expect(noRuntime.log).toHaveBeenCalledWith('No owned Caxri acceptance instance is running');
        expect(noRuntime.unlinkRuntime).not.toHaveBeenCalled();

        const invalid = dependencies({ readRuntime: vi.fn().mockResolvedValue('{}') });
        await expect(stopElectron(invalid)).rejects.toThrow(
            'Invalid /repo/.records/acceptance/runtime.json',
        );
        expect(invalid.unlinkRuntime).not.toHaveBeenCalled();
        expect(invalid.removeOwnedUserData).not.toHaveBeenCalled();
    });

    it('removes stale state and its explicitly owned profile without signaling a process', async () => {
        const stale = dependencies();
        await expect(stopElectron(stale)).resolves.toBeUndefined();
        expect(stale.kill).not.toHaveBeenCalled();
        expect(stale.unlinkRuntime).toHaveBeenCalledOnce();
        expect(stale.removeOwnedUserData).toHaveBeenCalledWith(runtime);
        expect(stale.log).toHaveBeenCalledWith('Removed stale Caxri acceptance runtime state');
    });

    it('signals the live launcher and cleans up only after ownership disappears', async () => {
        const isOwnedRuntime = vi
            .fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(false);
        const live = dependencies({ isOwnedRuntime });

        await expect(stopElectron(live)).resolves.toBeUndefined();
        expect(live.kill).toHaveBeenCalledWith(111, 'SIGTERM');
        expect(live.unlinkRuntime).toHaveBeenCalledOnce();
        expect(live.removeOwnedUserData).toHaveBeenCalledWith(runtime);
        expect(live.log).toHaveBeenCalledWith('Stopped owned Caxri acceptance instance');
    });

    it('signals Electron when the launcher is gone but the Electron identity is still owned', async () => {
        const isOwnedRuntime = vi
            .fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(false);
        const live = dependencies({
            isOwnedLauncher: vi.fn().mockResolvedValue(false),
            isOwnedRuntime,
        });

        await stopElectron(live);
        expect(live.kill).toHaveBeenCalledWith(222, 'SIGTERM');
    });

    it('fails closed on timeout and retains runtime state and user data', async () => {
        const timestamps = [0, 0, 10_000];
        const live = dependencies({
            isOwnedRuntime: vi.fn().mockResolvedValue(true),
            now: () => timestamps.shift() ?? 10_000,
        });

        await expect(stopElectron(live)).rejects.toThrow('Acceptance owner PID 111 did not stop');
        expect(live.unlinkRuntime).not.toHaveBeenCalled();
        expect(live.removeOwnedUserData).not.toHaveBeenCalled();
    });
});

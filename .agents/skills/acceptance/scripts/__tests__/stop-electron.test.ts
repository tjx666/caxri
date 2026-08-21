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
    ownedProcesses: [],
    ownedUserData: true,
    port: 9222,
    projectRoot: '/repo',
    startedAt: '2026-08-21T00:00:00.000Z',
    testRootPath: '/tmp/project',
    testRootPaths: ['/tmp/project'],
    userDataDir: '/tmp/caxri-acceptance-user-stop-case',
};

function dependencies(overrides: Partial<StopElectronDependencies> = {}): StopElectronDependencies {
    return {
        discoverOwnedProcesses: vi.fn().mockResolvedValue([]),
        isCdpReachable: vi.fn().mockResolvedValue(false),
        isOwnedLauncher: vi.fn().mockResolvedValue(true),
        isOwnedProcess: vi.fn().mockResolvedValue(true),
        isOwnedRuntime: vi.fn().mockResolvedValue(false),
        kill: vi.fn(),
        log: vi.fn(),
        now: () => 0,
        projectRoot: '/repo',
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

    it('recovers detached owned Host and Runtime processes after the window exits', async () => {
        const liveProcessIds = new Set([333, 444]);
        const detachedProcesses = [
            { identity: 'host identity', pid: 333, role: 'host' },
            { identity: 'runtime identity', pid: 444, role: 'runtime' },
        ] as const;
        const kill = vi.fn((pid: number) => {
            liveProcessIds.delete(pid);
        });
        const detached = dependencies({
            isOwnedLauncher: vi.fn().mockResolvedValue(false),
            isOwnedRuntime: vi.fn().mockResolvedValue(false),
            kill,
        });
        Object.assign(detached, {
            discoverOwnedProcesses: vi.fn().mockResolvedValue(detachedProcesses),
            isOwnedProcess: vi.fn(({ pid }: (typeof detachedProcesses)[number]) =>
                Promise.resolve(liveProcessIds.has(pid)),
            ),
        });

        await stopElectron(detached);

        expect(liveProcessIds).toHaveLength(0);
        expect(kill).toHaveBeenCalledWith(333, 'SIGTERM');
        expect(kill).toHaveBeenCalledWith(444, 'SIGTERM');
    });

    it('recovers a recorded Runtime after its Host and profile lock are gone', async () => {
        const orphanRuntime = { identity: 'orphan runtime identity', pid: 444, role: 'runtime' };
        let isRuntimeAlive = true;
        const kill = vi.fn((pid: number) => {
            if (pid === orphanRuntime.pid) isRuntimeAlive = false;
        });
        const orphan = dependencies({
            discoverOwnedProcesses: vi.fn().mockResolvedValue([]),
            isOwnedLauncher: vi.fn().mockResolvedValue(false),
            isOwnedProcess: vi.fn(({ pid }: { pid: number }) =>
                Promise.resolve(pid === orphanRuntime.pid && isRuntimeAlive),
            ),
            isOwnedRuntime: vi.fn().mockResolvedValue(false),
            kill,
            readRuntime: vi
                .fn()
                .mockResolvedValue(JSON.stringify({ ...runtime, ownedProcesses: [orphanRuntime] })),
        });

        await stopElectron(orphan);

        expect(kill).toHaveBeenCalledWith(444, 'SIGTERM');
        expect(orphan.unlinkRuntime).toHaveBeenCalledOnce();
        expect(orphan.removeOwnedUserData).toHaveBeenCalledOnce();
    });

    it('fails closed when a replacement Host owns the recorded profile', async () => {
        const recordedHost = {
            identity: 'recorded host identity',
            pid: 333,
            role: 'host',
        } as const;
        const replacementProcesses = [
            { identity: 'replacement host identity', pid: 555, role: 'host' },
            { identity: 'replacement runtime identity', pid: 666, role: 'runtime' },
        ] as const;
        const timestamps = [0, 0, 10_000];
        const replacement = dependencies({
            discoverOwnedProcesses: vi.fn().mockResolvedValue(replacementProcesses),
            isOwnedLauncher: vi.fn().mockResolvedValue(false),
            isOwnedProcess: vi.fn().mockResolvedValue(true),
            isOwnedRuntime: vi.fn().mockResolvedValue(false),
            now: () => timestamps.shift() ?? 10_000,
            readRuntime: vi
                .fn()
                .mockResolvedValue(JSON.stringify({ ...runtime, ownedProcesses: [recordedHost] })),
        });

        await expect(stopElectron(replacement)).rejects.toThrow(
            'Acceptance profile owner changed process identity',
        );
        expect(replacement.kill).not.toHaveBeenCalled();
        expect(replacement.unlinkRuntime).not.toHaveBeenCalled();
        expect(replacement.removeOwnedUserData).not.toHaveBeenCalled();
    });

    it('fails closed on timeout and retains runtime state and user data', async () => {
        const timestamps = [0, 0, 10_000];
        const live = dependencies({
            isOwnedRuntime: vi.fn().mockResolvedValue(true),
            now: () => timestamps.shift() ?? 10_000,
        });

        await expect(stopElectron(live)).rejects.toThrow(
            'Owned Acceptance processes or CDP did not stop',
        );
        expect(live.unlinkRuntime).not.toHaveBeenCalled();
        expect(live.removeOwnedUserData).not.toHaveBeenCalled();
    });
});

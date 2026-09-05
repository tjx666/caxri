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
        forceCompleteCaseLifecycle: vi.fn().mockResolvedValue('already_completed'),
        isCdpReachable: vi.fn().mockResolvedValue(false),
        isOwnedLauncher: vi.fn().mockResolvedValue(false),
        isOwnedProcess: vi.fn().mockResolvedValue(true),
        isOwnedRuntime: vi.fn().mockResolvedValue(false),
        isOwnedUserDataRemoved: vi.fn().mockResolvedValue(true),
        kill: vi.fn(),
        log: vi.fn(),
        now: () => 0,
        projectRoot: '/repo',
        readRuntime: vi.fn().mockResolvedValue(JSON.stringify(runtime)),
        removeOwnedUserData: vi.fn().mockResolvedValue(undefined),
        runtimePath: '/repo/.records/acceptance/runtime.json',
        sleep: vi.fn().mockResolvedValue(undefined),
        unlinkRuntime: vi.fn().mockResolvedValue(undefined),
        writeRuntime: vi.fn().mockResolvedValue(undefined),
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
        const stale = dependencies({
            isOwnedProcess: vi.fn().mockResolvedValue(false),
            readRuntime: vi.fn().mockResolvedValue(
                JSON.stringify({
                    ...runtime,
                    ownedProcesses: [
                        { identity: 'dead server core', pid: 333, role: 'server-core' },
                    ],
                }),
            ),
        });
        await expect(stopElectron(stale)).resolves.toBeUndefined();
        expect(stale.kill).not.toHaveBeenCalled();
        expect(stale.unlinkRuntime).toHaveBeenCalledOnce();
        expect(stale.removeOwnedUserData).toHaveBeenCalledOnce();
        expect(stale.log).toHaveBeenCalledWith('Stopped owned Caxri acceptance instance');
    });

    it('preserves state and profile when process ownership was never verified', async () => {
        const pending = dependencies({
            isOwnedLauncher: vi.fn().mockResolvedValue(false),
        });

        await expect(stopElectron(pending)).rejects.toThrow(
            'Acceptance process ownership was never verified',
        );
        expect(pending.kill).not.toHaveBeenCalled();
        expect(pending.unlinkRuntime).not.toHaveBeenCalled();
        expect(pending.removeOwnedUserData).not.toHaveBeenCalled();
    });

    it('signals the live launcher and cleans up only after ownership disappears', async () => {
        const isOwnedRuntime = vi
            .fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(false);
        const live = dependencies({
            isOwnedLauncher: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
            isOwnedProcess: vi.fn(({ pid }: { pid: number }) => Promise.resolve(pid !== 333)),
            isOwnedRuntime,
            readRuntime: vi.fn().mockResolvedValue(
                JSON.stringify({
                    ...runtime,
                    ownedProcesses: [
                        { identity: 'dead server core', pid: 333, role: 'server-core' },
                    ],
                }),
            ),
        });

        await expect(stopElectron(live)).resolves.toBeUndefined();
        expect(live.kill).toHaveBeenCalledWith(111, 'SIGTERM');
        expect(live.unlinkRuntime).toHaveBeenCalledOnce();
        expect(live.removeOwnedUserData).toHaveBeenCalledOnce();
        expect(live.log).toHaveBeenCalledWith('Stopped owned Caxri acceptance instance');
        // Runtime state written before receipt ownership was recorded has nothing to complete.
        expect(live.forceCompleteCaseLifecycle).not.toHaveBeenCalled();
    });

    it('signals Electron when the launcher is gone but the Electron identity is still owned', async () => {
        const isOwnedRuntime = vi
            .fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(false);
        const live = dependencies({
            isOwnedLauncher: vi.fn().mockResolvedValue(false),
            isOwnedProcess: vi.fn(({ pid }: { pid: number }) => Promise.resolve(pid !== 333)),
            isOwnedRuntime,
            readRuntime: vi.fn().mockResolvedValue(
                JSON.stringify({
                    ...runtime,
                    ownedProcesses: [
                        { identity: 'dead server core', pid: 333, role: 'server-core' },
                    ],
                }),
            ),
        });

        await stopElectron(live);
        expect(live.kill).toHaveBeenCalledWith(222, 'SIGTERM');
    });

    it('recovers detached Server Core and Extension Host processes after the window exits', async () => {
        const liveProcessIds = new Set([333, 444]);
        const detachedProcesses = [
            { identity: 'server core identity', pid: 333, role: 'server-core' },
            { identity: 'extension host identity', pid: 444, role: 'extension-host' },
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

    it('recovers a recorded Extension Host after Server Core and the profile lock are gone', async () => {
        const orphanExtensionHost = {
            identity: 'orphan extension host identity',
            pid: 444,
            role: 'extension-host',
        };
        let isExtensionHostAlive = true;
        const kill = vi.fn((pid: number) => {
            if (pid === orphanExtensionHost.pid) isExtensionHostAlive = false;
        });
        const orphan = dependencies({
            discoverOwnedProcesses: vi.fn().mockResolvedValue([]),
            isOwnedLauncher: vi.fn().mockResolvedValue(false),
            isOwnedProcess: vi.fn(({ pid }: { pid: number }) =>
                Promise.resolve(pid === orphanExtensionHost.pid && isExtensionHostAlive),
            ),
            isOwnedRuntime: vi.fn().mockResolvedValue(false),
            kill,
            readRuntime: vi
                .fn()
                .mockResolvedValue(
                    JSON.stringify({ ...runtime, ownedProcesses: [orphanExtensionHost] }),
                ),
        });

        await stopElectron(orphan);

        expect(kill).toHaveBeenCalledWith(444, 'SIGTERM');
        expect(orphan.unlinkRuntime).toHaveBeenCalledOnce();
        expect(orphan.removeOwnedUserData).toHaveBeenCalledOnce();
    });

    it('fails closed when a replacement Server Core owns the recorded profile', async () => {
        const recordedServerCore = {
            identity: 'recorded server core identity',
            pid: 333,
            role: 'server-core',
        } as const;
        const replacementProcesses = [
            { identity: 'replacement server core identity', pid: 555, role: 'server-core' },
            { identity: 'replacement extension host identity', pid: 666, role: 'extension-host' },
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
                .mockResolvedValue(
                    JSON.stringify({ ...runtime, ownedProcesses: [recordedServerCore] }),
                ),
        });

        await expect(stopElectron(replacement)).rejects.toThrow(
            'Acceptance profile owner changed process identity',
        );
        expect(replacement.kill).not.toHaveBeenCalled();
        expect(replacement.unlinkRuntime).not.toHaveBeenCalled();
        expect(replacement.removeOwnedUserData).not.toHaveBeenCalled();
    });

    it('captures and stops a new Server generation created during shutdown', async () => {
        const recordedServerCore = {
            identity: 'recorded server core identity',
            pid: 333,
            role: 'server-core',
        } as const;
        const replacementServerCore = {
            identity: 'replacement server core identity',
            pid: 555,
            role: 'server-core',
        } as const;
        const replacementExtensionHost = {
            identity: 'replacement extension host identity',
            pid: 666,
            role: 'extension-host',
        } as const;
        const liveProcessIds = new Set([333, 555, 666]);
        const discoverOwnedProcesses = vi
            .fn()
            .mockResolvedValueOnce([recordedServerCore])
            .mockResolvedValue([replacementServerCore, replacementExtensionHost]);
        const replacement = dependencies({
            discoverOwnedProcesses,
            isOwnedLauncher: vi.fn().mockResolvedValue(false),
            isOwnedProcess: vi.fn(({ pid }: { pid: number }) =>
                Promise.resolve(liveProcessIds.has(pid)),
            ),
            isOwnedRuntime: vi.fn().mockResolvedValue(false),
            kill: vi.fn((pid: number) => liveProcessIds.delete(pid)),
            readRuntime: vi
                .fn()
                .mockResolvedValue(
                    JSON.stringify({ ...runtime, ownedProcesses: [recordedServerCore] }),
                ),
        });

        await stopElectron(replacement);

        expect(replacement.kill).toHaveBeenCalledWith(333, 'SIGTERM');
        expect(replacement.kill).toHaveBeenCalledWith(555, 'SIGTERM');
        expect(replacement.kill).toHaveBeenCalledWith(666, 'SIGTERM');
        const persistedRuntime = vi.mocked(replacement.writeRuntime).mock.calls[0][0];
        expect(persistedRuntime.ownedProcesses).toContainEqual(replacementServerCore);
        expect(persistedRuntime.ownedProcesses).toContainEqual(replacementExtensionHost);
        expect(replacement.removeOwnedUserData).toHaveBeenCalledOnce();
    });

    it('persists a newly discovered Extension Host identity before signaling it', async () => {
        const recordedProcesses = [
            { identity: 'server core identity', pid: 333, role: 'server-core' },
            { identity: 'old extension host identity', pid: 444, role: 'extension-host' },
        ] as const;
        const discoveredProcesses = [
            recordedProcesses[0],
            { identity: 'new extension host identity', pid: 555, role: 'extension-host' },
        ] as const;
        const liveProcessIds = new Set([333, 555]);
        const replacement = dependencies({
            discoverOwnedProcesses: vi.fn().mockResolvedValue(discoveredProcesses),
            isOwnedLauncher: vi.fn().mockResolvedValue(false),
            isOwnedProcess: vi.fn(({ pid }: { pid: number }) =>
                Promise.resolve(liveProcessIds.has(pid)),
            ),
            isOwnedRuntime: vi.fn().mockResolvedValue(false),
            kill: vi.fn((pid: number) => liveProcessIds.delete(pid)),
            readRuntime: vi
                .fn()
                .mockResolvedValue(
                    JSON.stringify({ ...runtime, ownedProcesses: recordedProcesses }),
                ),
        });

        await stopElectron(replacement);

        const persistedRuntime = vi.mocked(replacement.writeRuntime).mock.calls[0][0];
        expect(persistedRuntime.ownedProcesses).toContainEqual(discoveredProcesses[1]);
        expect(replacement.kill).toHaveBeenCalledWith(555, 'SIGTERM');
    });

    it('fails closed on timeout and retains runtime state and user data', async () => {
        const timestamps = [0, 0, 10_000];
        const live = dependencies({
            isOwnedProcess: vi.fn().mockResolvedValue(true),
            isOwnedRuntime: vi.fn().mockResolvedValue(true),
            now: () => timestamps.shift() ?? 10_000,
            readRuntime: vi.fn().mockResolvedValue(
                JSON.stringify({
                    ...runtime,
                    ownedProcesses: [
                        { identity: 'live server core', pid: 333, role: 'server-core' },
                    ],
                }),
            ),
        });

        await expect(stopElectron(live)).rejects.toThrow(
            'Owned Acceptance processes or CDP did not stop',
        );
        expect(live.unlinkRuntime).not.toHaveBeenCalled();
        expect(live.removeOwnedUserData).not.toHaveBeenCalled();
    });

    /**
     * Virtual clock: `now` reads the clock and `sleep` advances it, so a whole slow teardown runs instantly while every
     * grace and force deadline is still evaluated against real elapsed milliseconds.
     */
    function launcherScenario(input: {
        /**
         * Period of a CDP probe that keeps flipping between reachable and unreachable, as a stalled main thread
         * produces against the 500ms probe timeout.
         */
        cdpFlapPeriodMs?: number;
        electronExitsAt?: number;
        launcherExitsAt: number;
        launcherGraceMs?: number;
        /**
         * By default the window and Server Core exit with the launcher, as a launcher that finishes its own teardown
         * leaves them. A launcher killed mid-teardown strands them instead, and they then only die to SIGKILL.
         */
        orphansOutliveLauncher?: boolean;
        withReceipt?: boolean;
    }) {
        let clock = 0;
        const liveProcessIds = new Set([111, 222, 333]);
        const isLauncherAlive = () => liveProcessIds.has(111) && clock < input.launcherExitsAt;
        const isOwnedByLauncher = () =>
            (input.orphansOutliveLauncher ?? false) || isLauncherAlive();
        const isServerCoreAlive = () => liveProcessIds.has(333) && isOwnedByLauncher();
        const isElectronAlive = () =>
            liveProcessIds.has(222) &&
            isOwnedByLauncher() &&
            clock < (input.electronExitsAt ?? Infinity);
        const isCdpReachable = () =>
            isElectronAlive() &&
            (input.cdpFlapPeriodMs === undefined ||
                Math.floor(clock / input.cdpFlapPeriodMs) % 2 === 0);
        const kill = vi.fn((pid: number, signal: NodeJS.Signals) => {
            if (signal === 'SIGKILL') liveProcessIds.delete(pid);
        });
        const dependencies_ = dependencies({
            isCdpReachable: vi.fn(() => Promise.resolve(isCdpReachable())),
            isOwnedLauncher: vi.fn(() => Promise.resolve(isLauncherAlive())),
            isOwnedProcess: vi.fn(({ pid }: { pid: number }) =>
                Promise.resolve(
                    pid === 111
                        ? isLauncherAlive()
                        : pid === 222
                          ? isElectronAlive()
                          : pid === 333
                            ? isServerCoreAlive()
                            : false,
                ),
            ),
            // Mirrors the real helper: the runtime stays owned while either the launcher or the window is alive.
            isOwnedRuntime: vi.fn(() => Promise.resolve(isLauncherAlive() || isElectronAlive())),
            kill,
            now: () => clock,
            readRuntime: vi.fn().mockResolvedValue(
                JSON.stringify({
                    ...runtime,
                    acceptanceCase:
                        input.withReceipt === false
                            ? runtime.acceptanceCase
                            : {
                                  ...runtime.acceptanceCase,
                                  lifecycleLaunchId: 'launch-1',
                                  reportDirectory: '/repo/.records/acceptance/round-1',
                              },
                    ownedProcesses: [
                        { identity: 'live server core', pid: 333, role: 'server-core' },
                    ],
                }),
            ),
            sleep: vi.fn((milliseconds: number) => {
                clock += milliseconds;
                return Promise.resolve();
            }),
        });
        return {
            deps: dependencies_,
            kill,
            run: () => stopElectron(dependencies_, { launcherGraceMs: input.launcherGraceMs }),
        };
    }

    it('lets a slow launcher finish its own teardown instead of killing it after five seconds', async () => {
        const { deps, kill, run } = launcherScenario({ launcherExitsAt: 12_000 });

        await expect(run()).resolves.toBeUndefined();

        expect(kill).toHaveBeenCalledWith(111, 'SIGTERM');
        expect(kill).not.toHaveBeenCalledWith(111, 'SIGKILL');
        // Server Core belongs to the launcher while it is alive; it exits with the launcher and is never signaled.
        expect(kill).not.toHaveBeenCalledWith(333, 'SIGTERM');
        expect(kill).not.toHaveBeenCalledWith(333, 'SIGKILL');
        expect(deps.forceCompleteCaseLifecycle).toHaveBeenCalledWith(
            '/repo/.records/acceptance/round-1',
            expect.objectContaining({
                caseId: 'stop-case',
                launchId: 'launch-1',
                source: 'stop-electron',
            }),
        );
        expect(deps.log).not.toHaveBeenCalledWith(
            expect.stringContaining('Completed lifecycle receipt'),
        );
        expect(deps.log).toHaveBeenCalledWith('Stopped owned Caxri acceptance instance');
    });

    it('force-kills a launcher that stops making progress and completes the receipt itself', async () => {
        const { deps, kill, run } = launcherScenario({
            launcherExitsAt: Infinity,
            launcherGraceMs: 30_000,
        });
        vi.mocked(deps.forceCompleteCaseLifecycle).mockResolvedValue('completed');

        await expect(run()).resolves.toBeUndefined();

        expect(kill).toHaveBeenCalledWith(111, 'SIGTERM');
        expect(kill).toHaveBeenCalledWith(111, 'SIGKILL');
        expect(kill).not.toHaveBeenCalledWith(333, 'SIGKILL');
        expect(deps.log).toHaveBeenCalledWith(
            expect.stringContaining('no teardown progress for 30000ms'),
        );
        expect(deps.forceCompleteCaseLifecycle).toHaveBeenCalledWith(
            '/repo/.records/acceptance/round-1',
            {
                caseId: 'stop-case',
                cleanupCompleted: true,
                cleanupRequested: true,
                launchId: 'launch-1',
                reason: expect.stringContaining('force-killed the launcher') as string,
                source: 'stop-electron',
            },
        );
        expect(deps.log).toHaveBeenCalledWith(
            expect.stringContaining('on behalf of the force-killed launcher'),
        );
    });

    it('extends the launcher grace while teardown is still making progress', async () => {
        // The window exit at 25s is the only progress signal; it is observed through the window's own identity.
        const { deps, kill, run } = launcherScenario({
            electronExitsAt: 25_000,
            launcherExitsAt: 45_000,
            launcherGraceMs: 30_000,
        });

        await expect(run()).resolves.toBeUndefined();

        expect(kill).not.toHaveBeenCalledWith(111, 'SIGKILL');
        expect(deps.isOwnedProcess).toHaveBeenCalledWith({
            identity: 'electron identity',
            pid: 222,
        });
        expect(deps.log).toHaveBeenCalledWith(
            expect.stringMatching(
                /^Acceptance launcher exited after 45\d{3}ms \(\d+ polls, grace 30000ms\)$/,
            ),
        );
    });

    it('force-kills a launcher whose progress never converges once the absolute deadline passes', async () => {
        const { deps, kill, run } = launcherScenario({
            cdpFlapPeriodMs: 500,
            launcherExitsAt: Infinity,
            launcherGraceMs: 1_000,
        });
        vi.mocked(deps.forceCompleteCaseLifecycle).mockResolvedValue('completed');

        await expect(run()).resolves.toBeUndefined();

        expect(kill).toHaveBeenCalledWith(111, 'SIGKILL');
        expect(deps.log).toHaveBeenCalledWith(
            expect.stringContaining('exceeded the 3000ms deadline'),
        );
        expect(deps.log).toHaveBeenCalledWith(
            expect.stringMatching(/^Acceptance launcher deadline-killed after 3\d{3}ms/),
        );
        expect(deps.forceCompleteCaseLifecycle).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
                reason: expect.stringContaining('absolute deadline') as string,
            }),
        );
    });

    it('hands the window and Server Core a deadline-killed launcher stranded to the owned-process tier', async () => {
        const { deps, kill, run } = launcherScenario({
            cdpFlapPeriodMs: 500,
            launcherExitsAt: Infinity,
            launcherGraceMs: 1_000,
            orphansOutliveLauncher: true,
        });
        vi.mocked(deps.forceCompleteCaseLifecycle).mockResolvedValue('completed');

        await expect(run()).resolves.toBeUndefined();

        const signals = kill.mock.calls.map(([pid, signal]) => `${signal}:${pid}`);
        expect(signals.indexOf('SIGKILL:111')).toBeLessThan(signals.indexOf('SIGTERM:222'));
        expect(signals.indexOf('SIGTERM:222')).toBeLessThan(signals.indexOf('SIGKILL:222'));
        expect(signals.indexOf('SIGTERM:333')).toBeLessThan(signals.indexOf('SIGKILL:333'));
        expect(deps.forceCompleteCaseLifecycle).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ launchId: 'launch-1', source: 'stop-electron' }),
        );
        expect(deps.log).toHaveBeenCalledWith('Stopped owned Caxri acceptance instance');
    });

    it('records unverified cleanup honestly when the profile still exists after a forced stop', async () => {
        const { deps, run } = launcherScenario({
            launcherExitsAt: Infinity,
            launcherGraceMs: 1_000,
        });
        vi.mocked(deps.isOwnedUserDataRemoved).mockResolvedValue(false);

        await run();

        expect(deps.forceCompleteCaseLifecycle).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ cleanupCompleted: false, cleanupRequested: true }),
        );
    });

    it('completes the receipt when the launcher was already gone before the stop', async () => {
        const { deps, run } = launcherScenario({ launcherExitsAt: 0 });
        vi.mocked(deps.forceCompleteCaseLifecycle).mockResolvedValue('completed');
        await run();
        expect(deps.forceCompleteCaseLifecycle).toHaveBeenCalledWith(
            '/repo/.records/acceptance/round-1',
            expect.objectContaining({
                launchId: 'launch-1',
                reason: expect.stringContaining('already gone') as string,
                source: 'stop-electron',
            }),
        );
        expect(deps.log).toHaveBeenCalledWith(
            expect.stringContaining('on behalf of the already-gone launcher'),
        );
    });

    it('says so when runtime state records no receipt ownership instead of skipping silently', async () => {
        const { deps, run } = launcherScenario({ launcherExitsAt: 0, withReceipt: false });
        await run();
        expect(deps.forceCompleteCaseLifecycle).not.toHaveBeenCalled();
        expect(deps.log).toHaveBeenCalledWith(
            expect.stringContaining(
                'records no lifecycle receipt ownership; if its launch is still pending, close it with `report.ts repair-lifecycle --dir <round> --case-id stop-case --reason "<why>"`',
            ),
        );
    });
});

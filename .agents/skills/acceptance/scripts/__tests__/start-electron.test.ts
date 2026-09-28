import type { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import type { DesktopLeaseHandle } from '../../../switch-worktree/scripts/desktop-lease';
import { validateAcceptanceAgentFixture } from '../agent-fixtures';
import {
    createElectronStopController,
    createMacosAcceptanceLaunchController,
    settleMacosAcceptanceLaunch,
} from '../macos-launch-lifecycle';
import type { RuntimeState } from '../runtime-state';
import type { StaleRuntimeDependencies } from '../start-electron';
import {
    createChildExitPromise,
    createElectronLaunchSpec,
    createMacosAcceptanceLaunchSpec,
    removeStaleRuntime,
    shouldPreserveInheritedRuntimeState,
    transferDesktopLeaseAfterCdp,
    waitForCdp,
    waitForOwnedProcesses,
} from '../start-electron';

const runtime: RuntimeState = {
    acceptanceCase: { id: 'start-case', mode: 'isolated' },
    cdpUrl: 'http://127.0.0.1:9222',
    electronIdentity: 'electron identity',
    electronPid: 222,
    launcherIdentity: 'launcher identity',
    launcherPid: 111,
    ownedProcesses: [
        { identity: 'server core identity', pid: 333, role: 'server-core' },
        { identity: 'extension host identity', pid: 444, role: 'extension-host' },
    ],
    ownedUserData: true,
    port: 9222,
    projectRoot: '/repo',
    startedAt: '2026-08-21T00:00:00.000Z',
    testRootPath: '/tmp/project',
    testRootPaths: ['/tmp/project'],
    userDataDir: '/tmp/caxri-acceptance-user-start-case',
};

function staleRuntimeDependencies(
    overrides: Partial<StaleRuntimeDependencies> = {},
): StaleRuntimeDependencies {
    return {
        canonicalPath: vi.fn((path: string) => Promise.resolve(path)),
        discoverOwnedProcesses: vi.fn().mockResolvedValue([]),
        isOwnedProcess: vi.fn().mockResolvedValue(false),
        isOwnedRuntime: vi.fn().mockResolvedValue(false),
        projectRoot: '/repo',
        readRuntime: vi.fn().mockResolvedValue(JSON.stringify(runtime)),
        removeOwnedUserData: vi.fn().mockResolvedValue(undefined),
        runtimePath: '/repo/.records/acceptance/runtime.json',
        unlinkRuntime: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

class FakeChild {
    private readonly listeners = new Map<string, (...arguments_: unknown[]) => void>();
    exitCode: number | null = null;
    pid = 1234;
    kill = vi.fn();

    once(event: string, listener: (...arguments_: unknown[]) => void): this {
        this.listeners.set(event, listener);
        return this;
    }

    emit(event: string, ...arguments_: unknown[]): boolean {
        const listener = this.listeners.get(event);
        this.listeners.delete(event);
        listener?.(...arguments_);
        return Boolean(listener);
    }
}

function childProcess(fake = new FakeChild()): ChildProcess {
    return fake as unknown as ChildProcess;
}

describe('Acceptance Electron launcher seams', () => {
    it.each([undefined, 'other-case', 'session-pr-open-parity'])(
        'binds external-open fixture authority to case %s',
        (caseId) => {
            const spec = createElectronLaunchSpec({
                caseId,
                port: 9222,
                testRootPath: '/tmp/project',
                testRootPaths: ['/tmp/project'],
                userDataDir: '/tmp/caxri-acceptance-owned',
                environment: { CAXRI_ACCEPTANCE_EXTERNAL_OPEN: 'session-pr-open-parity-v1' },
                agentEnvironment: { CAXRI_ACCEPTANCE_EXTERNAL_OPEN: 'session-pr-open-parity-v1' },
            });
            expect(spec.options.env.CAXRI_ACCEPTANCE_EXTERNAL_OPEN).toBe(
                caseId === 'session-pr-open-parity' ? 'session-pr-open-parity-v1' : undefined,
            );
        },
    );

    it.each([
        ['an undeclared case', 'issue-826-surface-seam', {}, undefined],
        ['an explicit opt-out', 'new-theme-case', { themeImportFixture: false }, undefined],
        ['a declared case', 'new-theme-case', { themeImportFixture: true }, 'new-theme-case'],
    ])('arms theme import for %s from its frozen plan', (_, caseId, declaredFixtures, expected) => {
        const spec = createElectronLaunchSpec({
            caseId,
            declaredFixtures,
            port: 9222,
            testRootPath: '/tmp/project',
            testRootPaths: ['/tmp/project'],
            userDataDir: '/tmp/caxri-acceptance-owned',
            environment: { CAXRI_ACCEPTANCE_THEME_IMPORT: 'issue-826-surface-seam' },
            agentEnvironment: { CAXRI_ACCEPTANCE_THEME_IMPORT: 'issue-826-surface-seam' },
        });
        expect(spec.options.env.CAXRI_ACCEPTANCE_THEME_IMPORT).toBe(expected);
    });

    it.each([
        ['an undeclared case', {}, undefined],
        [
            'a declared case',
            { updateFixture: 'available' as const },
            'available:update-notification',
        ],
    ])('arms the update fixture for %s from its frozen plan', (_, declaredFixtures, expected) => {
        const spec = createElectronLaunchSpec({
            caseId: 'update-notification',
            declaredFixtures,
            port: 9222,
            testRootPath: '/tmp/project',
            testRootPaths: ['/tmp/project'],
            userDataDir: '/tmp/caxri-acceptance-owned',
            environment: { CAXRI_ACCEPTANCE_UPDATE: 'available' },
            agentEnvironment: { CAXRI_ACCEPTANCE_UPDATE: 'available' },
        });
        expect(spec.options.env.CAXRI_ACCEPTANCE_UPDATE).toBe(expected);
    });

    it.each([
        ['an authorized, declared native handoff', 'explicit-user-request', false, '1'],
        ['an undeclared case with the marker', 'explicit-user-request', undefined, undefined],
        ['a declared handoff without the marker', undefined, false, undefined],
        ['a forged marker', 'yes', false, undefined],
    ])(
        'derives the native theme import capability for %s',
        (_, marker, themeImportFixture, expected) => {
            const spec = createElectronLaunchSpec({
                caseId: 'theme-native-handoff',
                declaredFixtures: { themeImportFixture },
                environment: {
                    CAXRI_ACCEPTANCE_NATIVE_DIALOG_AUTHORIZATION: marker,
                    CAXRI_ACCEPTANCE_NATIVE_THEME_IMPORT: '1',
                },
                port: 9222,
                testRootPath: '/tmp/project',
                testRootPaths: ['/tmp/project'],
                userDataDir: '/tmp/caxri-acceptance-owned',
            });
            expect(spec.options.env.CAXRI_ACCEPTANCE_NATIVE_THEME_IMPORT).toBe(expected);
        },
    );

    it('refuses a declared theme import fixture on a native-dialog launch', () => {
        expect(() =>
            createElectronLaunchSpec({
                caseId: 'new-theme-case',
                declaredFixtures: { themeImportFixture: true },
                environment: {
                    CAXRI_ACCEPTANCE_NATIVE_DIALOG_AUTHORIZATION: 'explicit-user-request',
                },
                port: 9222,
                testRootPath: '/tmp/project',
                testRootPaths: ['/tmp/project'],
                useTestRootFixture: false,
                userDataDir: '/tmp/caxri-acceptance-owned',
            }),
        ).toThrow('declares themeImportFixture, which needs the default test-root fixture');
    });

    it.each([
        [undefined, undefined, undefined],
        ['other-case', undefined, undefined],
        ['audit-naming-cancel', 'audit-naming-cancel', undefined],
        [
            'audit-extension-message-reasons',
            undefined,
            'parent-envelope,child-envelope,reply-result',
        ],
    ])(
        'binds Session deletion and protocol fault authority to case %s',
        (caseId, expectedDelete, expectedFaults) => {
            const spec = createElectronLaunchSpec({
                caseId,
                port: 9222,
                testRootPath: '/tmp/project',
                testRootPaths: ['/tmp/project'],
                userDataDir: '/tmp/caxri-acceptance-owned',
                environment: {
                    CAXRI_ACCEPTANCE_SESSION_DELETE: 'audit-argv-bounds',
                    CAXRI_E2E_EXTENSION_HOST_FAULTS: 'reply-result',
                    CAXRI_REAL_AGENT_OK: '1',
                },
            });
            // Every ambient value above names a different fixture than the expectation, so a launch value that matched
            // one would prove the case id was not what decided admission.
            expect(spec.options.env.CAXRI_ACCEPTANCE_SESSION_DELETE).toBe(expectedDelete);
            expect(spec.options.env.CAXRI_E2E_EXTENSION_HOST_FAULTS).toBe(expectedFaults);
            // `CAXRI_REAL_AGENT_OK` is stripped and never rewritten, so it proves the strip list itself still runs.
            expect(spec.options.env).not.toHaveProperty('CAXRI_REAL_AGENT_OK');
        },
    );

    it('protects a reused profile as soon as verified process ownership is inherited', () => {
        expect(shouldPreserveInheritedRuntimeState(runtime.ownedProcesses)).toBe(true);
        expect(shouldPreserveInheritedRuntimeState([])).toBe(false);
    });

    it('carries verified Server process identities into the next matching restart launch', async () => {
        const restartRuntime = {
            ...runtime,
            acceptanceCase: { id: 'start-case', mode: 'restart' as const },
        };
        const stale = staleRuntimeDependencies({
            discoverOwnedProcesses: vi.fn().mockResolvedValue(restartRuntime.ownedProcesses),
            isOwnedProcess: vi.fn().mockResolvedValue(true),
            readRuntime: vi.fn().mockResolvedValue(JSON.stringify(restartRuntime)),
        });

        await expect(
            removeStaleRuntime(stale, {
                caseId: 'start-case',
                userDataDir: restartRuntime.userDataDir,
            }),
        ).resolves.toEqual(restartRuntime.ownedProcesses);
        expect(stale.unlinkRuntime).not.toHaveBeenCalled();
        expect(stale.removeOwnedUserData).not.toHaveBeenCalled();
    });

    it('preserves state whose detached ownership was never verified', async () => {
        const stale = staleRuntimeDependencies({
            readRuntime: vi
                .fn()
                .mockResolvedValue(JSON.stringify({ ...runtime, ownedProcesses: [] })),
        });

        await expect(removeStaleRuntime(stale)).rejects.toThrow(
            'Acceptance process ownership was never verified',
        );
        expect(stale.unlinkRuntime).not.toHaveBeenCalled();
        expect(stale.removeOwnedUserData).not.toHaveBeenCalled();
    });

    it('preserves stale runtime state while a persisted detached process is still live', async () => {
        const stale = staleRuntimeDependencies({
            isOwnedProcess: vi.fn(({ pid }: { pid: number }) => Promise.resolve(pid === 444)),
        });

        await expect(removeStaleRuntime(stale)).rejects.toThrow(
            'Acceptance detached processes are still running',
        );
        expect(stale.unlinkRuntime).not.toHaveBeenCalled();
        expect(stale.removeOwnedUserData).not.toHaveBeenCalled();
    });

    it('waits for exact Server process ownership after CDP becomes reachable', async () => {
        const ownedProcesses = runtime.ownedProcesses;
        const discoverOwnedProcesses = vi
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce(ownedProcesses);

        await expect(
            waitForOwnedProcesses(runtime, '/repo', {
                discoverOwnedProcesses,
                now: () => 0,
                sleep: vi.fn().mockResolvedValue(undefined),
            }),
        ).resolves.toEqual(ownedProcesses);
        expect(discoverOwnedProcesses).toHaveBeenCalledTimes(2);
    });

    it('builds a structured Electron launch with the isolated Acceptance environment', () => {
        const launch = createElectronLaunchSpec({
            electronPath: '/repo/node_modules/.bin/electron',
            environment: {
                PATH: '/usr/bin',
                CAXRI_E2E: 'old',
                CAXRI_E2E_AGENT_HOOKS: '1',
                CAXRI_E2E_AGENT_MODE: 'real',
                CAXRI_E2E_AGENT_PROVIDER: 'codex',
                CAXRI_REAL_AGENT_E2E: '1',
                CAXRI_REAL_AGENT_OK: '1',
            },
            port: 9333,
            projectRoot: '/repo',
            testRootPath: '/project-one',
            testRootPaths: ['/project-one', '/project-two'],
            userDataDir: '/tmp/caxri-acceptance-user-case',
        });

        expect(launch).toEqual({
            args: ['apps/desktop', '--remote-debugging-port=9333'],
            command: '/repo/node_modules/.bin/electron',
            options: {
                cwd: '/repo',
                env: {
                    PATH: '/usr/bin',
                    CAXRI_ACCEPTANCE: '1',
                    CAXRI_E2E: '1',
                    CAXRI_E2E_AGENT_MODE: 'blocked',
                    CAXRI_E2E_WINDOW_MODE: 'visible',
                    CAXRI_TEST_ROOT_PATH: '/project-one',
                    CAXRI_TEST_ROOT_PATHS: '["/project-one","/project-two"]',
                    CAXRI_USER_DATA_DIR: '/tmp/caxri-acceptance-user-case',
                },
                stdio: 'inherit',
            },
        });
    });

    it('accepts only a plan-bound fake Agent environment', () => {
        expect(() =>
            validateAcceptanceAgentFixture('agent-case', undefined, 'agent-features-v1'),
        ).toThrow('Acceptance case agent-case does not declare an Agent fixture');
        expect(() =>
            validateAcceptanceAgentFixture('agent-case', 'agent-features-v1', undefined),
        ).toThrow('Acceptance case agent-case requires --agent-fixture agent-features-v1');
        expect(() =>
            validateAcceptanceAgentFixture('agent-case', 'agent-features-v1', 'agent-features-v1'),
        ).not.toThrow();

        const launch = createElectronLaunchSpec({
            agentEnvironment: {
                CAXRI_E2E_AGENT_HOOKS: '1',
                CAXRI_E2E_AGENT_MODE: 'fake',
                CAXRI_E2E_FAKE_CLAUDE_EXECUTABLE: '/owned/claude',
                HOME: '/owned/home',
                PATH: '/owned/bin:/usr/bin',
            },
            electronPath: '/repo/node_modules/.bin/electron',
            environment: {
                CAXRI_E2E_AGENT_MODE: 'real',
                CAXRI_E2E_AGENT_PROVIDER: 'codex',
                CAXRI_REAL_AGENT_OK: '1',
                HOME: '/developer/home',
                PATH: '/developer/bin',
            },
            port: 9333,
            projectRoot: '/repo',
            testRootPath: '/project-one',
            testRootPaths: ['/project-one'],
            userDataDir: '/tmp/caxri-acceptance-user-case',
        });

        expect(launch.options.env).toMatchObject({
            CAXRI_E2E_AGENT_HOOKS: '1',
            CAXRI_E2E_AGENT_MODE: 'fake',
            CAXRI_E2E_FAKE_CLAUDE_EXECUTABLE: '/owned/claude',
            HOME: '/owned/home',
            PATH: '/owned/bin:/usr/bin',
        });
        expect(launch.options.env).not.toHaveProperty('CAXRI_E2E_AGENT_PROVIDER');
        expect(launch.options.env).not.toHaveProperty('CAXRI_REAL_AGENT_OK');
    });

    it('rejects the real native dialog boundary without current-request user authorization', () => {
        expect(() =>
            createElectronLaunchSpec({
                electronPath: '/repo/node_modules/.bin/electron',
                environment: { PATH: '/usr/bin' },
                port: 9333,
                projectRoot: '/repo',
                testRootPath: '/project-one',
                testRootPaths: ['/project-one'],
                useTestRootFixture: false,
                userDataDir: '/tmp/caxri-acceptance-user-case',
            }),
        ).toThrow('Native dialog automation requires an explicit user request');
    });

    it('can leave folder selection on the explicitly authorized native dialog boundary', () => {
        const launch = createElectronLaunchSpec({
            caseId: 'issue-826-surface-seam',
            electronPath: '/repo/node_modules/.bin/electron',
            environment: {
                PATH: '/usr/bin',
                CAXRI_ACCEPTANCE_NATIVE_DIALOG_AUTHORIZATION: 'explicit-user-request',
                CAXRI_ACCEPTANCE_THEME_IMPORT: 'issue-826-surface-seam',
                CAXRI_TEST_ROOT_PATH: '/inherited-root',
                CAXRI_TEST_ROOT_PATHS: '["/inherited-root"]',
            },
            port: 9333,
            projectRoot: '/repo',
            testRootPath: '/project-one',
            testRootPaths: ['/project-one'],
            useTestRootFixture: false,
            userDataDir: '/tmp/caxri-acceptance-user-case',
        });

        expect(launch.options.env).not.toHaveProperty('CAXRI_TEST_ROOT_PATH');
        expect(launch.options.env).not.toHaveProperty('CAXRI_TEST_ROOT_PATHS');
        expect(launch.options.env.CAXRI_ACCEPTANCE_THEME_IMPORT).toBeUndefined();
        expect(launch.options.env).toMatchObject({
            CAXRI_ACCEPTANCE: '1',
            CAXRI_ACCEPTANCE_NATIVE_DIALOG_AUTHORIZATION: 'explicit-user-request',
            CAXRI_E2E: '1',
            CAXRI_USER_DATA_DIR: '/tmp/caxri-acceptance-user-case',
        });
    });

    it('launches the unique app through LaunchServices while preserving its environment', () => {
        const launch = createMacosAcceptanceLaunchSpec({
            appPath: '/tmp/Caxri Acceptance 01234567.app',
            environment: { NODE_OPTIONS: '--max-old-space-size=16384', PATH: '/usr/bin' },
            port: 9333,
            projectRoot: '/repo',
            testRootPath: '/project-one',
            testRootPaths: ['/project-one'],
            userDataDir: '/tmp/caxri-acceptance-user-case',
        });

        expect(launch).toEqual({
            args: [
                '-n',
                '-W',
                '/tmp/Caxri Acceptance 01234567.app',
                '--args',
                '/repo/apps/desktop',
                '--remote-debugging-port=9333',
            ],
            command: '/usr/bin/open',
            options: {
                cwd: '/repo',
                env: {
                    NODE_OPTIONS: '--max-old-space-size=16384',
                    PATH: '/usr/bin',
                    CAXRI_ACCEPTANCE: '1',
                    CAXRI_E2E: '1',
                    CAXRI_E2E_AGENT_MODE: 'blocked',
                    CAXRI_E2E_WINDOW_MODE: 'visible',
                    CAXRI_TEST_ROOT_PATH: '/project-one',
                    CAXRI_TEST_ROOT_PATHS: '["/project-one"]',
                    CAXRI_USER_DATA_DIR: '/tmp/caxri-acceptance-user-case',
                },
                stdio: 'inherit',
            },
        });
    });

    it('reports both exit and spawn-error outcomes without launching a process', async () => {
        const exited = new FakeChild();
        const exit = createChildExitPromise(childProcess(exited));
        exited.emit('exit', 7, 'SIGTERM');
        await expect(exit).resolves.toEqual({ code: 7, signal: 'SIGTERM' });

        const failed = new FakeChild();
        const error = createChildExitPromise(childProcess(failed));
        failed.emit('error', new Error('spawn failed'));
        await expect(error).rejects.toThrow('spawn failed');
    });

    it('makes stop idempotent and escalates only after the force-stop delay', () => {
        const fake = new FakeChild();
        const unref = vi.fn();
        let forceStop: (() => void) | undefined;
        const scheduleForceStop = vi.fn((callback: () => void, milliseconds: number) => {
            expect(milliseconds).toBe(5_000);
            forceStop = callback;
            return { unref };
        });
        const controller = createElectronStopController(childProcess(fake), {
            isAlive: () => true,
            scheduleForceStop,
        });

        controller.stop();
        controller.stop();
        expect(controller.isStopping).toBe(true);
        expect(fake.kill).toHaveBeenCalledTimes(1);
        expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
        expect(scheduleForceStop).toHaveBeenCalledTimes(1);
        expect(unref).toHaveBeenCalledOnce();

        forceStop?.();
        expect(fake.kill).toHaveBeenLastCalledWith('SIGKILL');
    });

    it('sweeps the unique cloned app when launch stops before PID discovery', async () => {
        const launchProcess = new FakeChild();
        const stopUndiscoveredProcesses = vi.fn().mockResolvedValue([]);
        const controller = createMacosAcceptanceLaunchController(
            childProcess(launchProcess),
            '/tmp/profile/apps.noindex/Caxri Acceptance 01234567.app/Contents/MacOS/Electron',
            {
                createElectronController: vi.fn(),
                stopUndiscoveredProcesses,
            },
        );

        controller.stop();
        await controller.cleanup();
        await controller.cleanup();

        expect(launchProcess.kill).toHaveBeenCalledOnce();
        expect(launchProcess.kill).toHaveBeenCalledWith('SIGTERM');
        expect(stopUndiscoveredProcesses).toHaveBeenCalledOnce();
        expect(stopUndiscoveredProcesses).toHaveBeenCalledWith(
            '/tmp/profile/apps.noindex/Caxri Acceptance 01234567.app/Contents/MacOS/Electron',
        );
    });

    it('preserves the profile and removes signal listeners when the unique-path sweep fails', async () => {
        const cleanupError = new Error('process listing failed');
        const cleanup = vi.fn().mockRejectedValue(cleanupError);
        const removeSignalListeners = vi.fn();

        await expect(
            settleMacosAcceptanceLaunch(
                { cleanup },
                Promise.resolve({ code: null, signal: 'SIGTERM' }),
                removeSignalListeners,
            ),
        ).resolves.toEqual({ cleanupError, isSafeToRemoveProfile: false });
        expect(cleanup).toHaveBeenCalledOnce();
        expect(removeSignalListeners).toHaveBeenCalledOnce();
    });

    it('waits for CDP readiness and fails closed on early exit or timeout', async () => {
        const readyChild = new FakeChild();
        const fetchProbe = vi
            .fn()
            .mockRejectedValueOnce(new Error('not listening'))
            .mockResolvedValueOnce({ ok: true });
        const sleep = vi.fn().mockResolvedValue(undefined);
        await expect(
            waitForCdp(9333, childProcess(readyChild), {
                fetch: fetchProbe as unknown as typeof fetch,
                now: () => 0,
                sleep,
            }),
        ).resolves.toBeUndefined();
        expect(fetchProbe).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledWith(250);

        const exitedChild = new FakeChild();
        exitedChild.exitCode = 9;
        await expect(
            waitForCdp(9333, childProcess(exitedChild), {
                fetch: vi.fn() as unknown as typeof fetch,
                now: () => 0,
                sleep,
            }),
        ).rejects.toThrow('Electron exited before CDP became ready (9)');

        const timestamps = [0, 30_000];
        await expect(
            waitForCdp(9333, childProcess(), {
                fetch: vi.fn() as unknown as typeof fetch,
                now: () => timestamps.shift() ?? 30_000,
                sleep,
            }),
        ).rejects.toThrow('Timed out waiting for CDP on port 9333');
    });

    it('transfers the desktop lease only after Electron exposes its stable CDP process identity', async () => {
        const order: string[] = [];
        const lease = { token: 'lease-token' } as DesktopLeaseHandle;
        const transferredLease = {
            ...lease,
            identity: 'stable Caxri Dev identity',
            pid: 1234,
        };
        const result = await transferDesktopLeaseAfterCdp(lease, 1234, 9333, childProcess(), {
            getProcessIdentity: vi.fn(() => {
                order.push('identity');
                return Promise.resolve('stable Caxri Dev identity');
            }),
            transferDesktopLease: vi.fn(() => {
                order.push('transfer');
                return Promise.resolve(transferredLease);
            }),
            waitForCdp: vi.fn(() => {
                order.push('cdp');
                return Promise.resolve();
            }),
        });

        expect(order).toEqual(['cdp', 'identity', 'transfer']);
        expect(result).toEqual({
            desktopLease: transferredLease,
            electronIdentity: 'stable Caxri Dev identity',
        });
    });
});

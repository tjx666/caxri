import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { describe, expect, it, vi } from 'vitest';

import {
    discoverOwnedProcesses,
    errorCode,
    getProcessCommand,
    getProcessIdentity,
    isAcceptanceProfileIdentityRemoved,
    isAlive,
    isOwnedLauncher,
    isOwnedRuntime,
    prepareAcceptanceUserData,
    ProcessProbeTimeoutError,
    removeOwnedUserData,
    runProcessProbe,
    runtimeStateSchema,
} from './runtime-state';

describe('Acceptance runtime ownership', () => {
    it('validates the ownership fields persisted by the launcher', () => {
        expect(
            runtimeStateSchema.parse({
                cdpUrl: 'http://127.0.0.1:9222',
                electronIdentity: 'started-at electron command',
                electronPid: 124,
                launcherIdentity: 'started-at command',
                launcherPid: 123,
                ownedProcesses: [
                    { identity: 'server core identity', pid: 333, role: 'server-core' },
                    { identity: 'extension host identity', pid: 444, role: 'extension-host' },
                ],
                ownedUserData: true,
                port: 9222,
                projectRoot: '/repo',
                startedAt: '2026-08-09T00:00:00.000Z',
                testRootPath: '/tmp/project',
                testRootPaths: ['/tmp/project', '/tmp/project-two'],
                userDataDir: '/tmp/caxri-acceptance-user-test',
            }).launcherIdentity,
        ).toBe('started-at command');
        const missingError = Object.assign(new Error('missing'), { code: 'ENOENT' });
        expect(errorCode(missingError)).toBe('ENOENT');
    });

    it('anchors launcher ownership to process identity instead of PID alone', async () => {
        const identity = await getProcessIdentity(process.pid);

        expect(identity).toBeTruthy();
        if (!identity) throw new Error('Current process identity is unavailable');
        await expect(
            isOwnedLauncher({ launcherIdentity: identity, launcherPid: process.pid }),
        ).resolves.toBe(true);
        await expect(
            isOwnedLauncher({ launcherIdentity: 'recycled process', launcherPid: process.pid }),
        ).resolves.toBe(false);
        expect(isAlive(2_147_483_647)).toBe(false);
    });

    it('fails closed when the process command probe cannot start', async () => {
        const missingExecutable = join(tmpdir(), 'caxri-missing-process-query');
        await expect(getProcessCommand(process.pid, missingExecutable)).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('keeps an Acceptance runtime owned when its launcher has died but Electron remains live', async () => {
        const identity = await getProcessIdentity(process.pid);
        expect(identity).toBeTruthy();
        if (!identity) throw new Error('Current process identity is unavailable');

        await expect(
            isOwnedRuntime({
                electronIdentity: identity,
                electronPid: process.pid,
                launcherIdentity: 'dead launcher identity',
                launcherPid: process.pid,
            }),
        ).resolves.toBe(true);
    });

    it('discovers only the exact worktree Server Core and its Extension Host child', async () => {
        const getProcessIdentity = vi.fn((pid: number) => Promise.resolve(`identity-${pid}`));
        const dependencies = {
            canonicalPath: vi.fn((path: string) => Promise.resolve(path)),
            getProcessCommand: vi
                .fn()
                .mockResolvedValue(
                    '/repo/apps/server/dist/server/runtime/bin/node /repo/apps/server/dist/server/bundles/server-core.js',
                ),
            getProcessIdentity,
            inspectPathOwner: vi.fn().mockResolvedValue(333),
            listChildProcesses: vi.fn().mockResolvedValue([
                {
                    command:
                        '/repo/apps/server/dist/server/runtime/bin/node /repo/apps/server/dist/server/bundles/extension-host.js',
                    pid: 444,
                },
                {
                    command:
                        '/repo-sibling/apps/server/dist/server/runtime/bin/node /repo-sibling/apps/server/dist/server/bundles/extension-host.js',
                    pid: 555,
                },
            ]),
        };

        await expect(
            discoverOwnedProcesses(
                { projectRoot: '/repo', userDataDir: '/tmp/acceptance-profile' },
                '/repo',
                dependencies,
            ),
        ).resolves.toEqual([
            { identity: 'identity-333', pid: 333, role: 'server-core' },
            { identity: 'identity-444', pid: 444, role: 'extension-host' },
        ]);
        expect(getProcessIdentity).not.toHaveBeenCalledWith(555);

        await expect(
            discoverOwnedProcesses(
                { projectRoot: '/repo-sibling', userDataDir: '/tmp/acceptance-profile' },
                '/repo',
                dependencies,
            ),
        ).rejects.toThrow('different worktree');
    });

    it('fails closed when the profile lock owner does not run the recorded worktree Server Core', async () => {
        await expect(
            discoverOwnedProcesses(
                { projectRoot: '/repo', userDataDir: '/tmp/acceptance-profile' },
                '/repo',
                {
                    canonicalPath: vi.fn((path: string) => Promise.resolve(path)),
                    getProcessCommand: vi
                        .fn()
                        .mockResolvedValue(
                            '/repo-sibling/apps/server/dist/server/runtime/bin/node /repo-sibling/apps/server/dist/server/bundles/server-core.js',
                        ),
                    getProcessIdentity: vi.fn().mockResolvedValue('identity-333'),
                    inspectPathOwner: vi.fn().mockResolvedValue(333),
                    listChildProcesses: vi.fn().mockResolvedValue([]),
                },
            ),
        ).rejects.toThrow('outside the recorded worktree');
    });

    it('ignores a stale profile lock when its Server Core process has exited', async () => {
        await expect(
            discoverOwnedProcesses(
                { projectRoot: '/repo', userDataDir: '/tmp/acceptance-profile' },
                '/repo',
                {
                    canonicalPath: vi.fn((path: string) => Promise.resolve(path)),
                    getProcessCommand: vi.fn().mockResolvedValue(null),
                    getProcessIdentity: vi.fn().mockResolvedValue(null),
                    inspectPathOwner: vi.fn().mockResolvedValue(333),
                    listChildProcesses: vi.fn().mockResolvedValue([]),
                },
            ),
        ).resolves.toEqual([]);
    });

    it('removes only explicitly owned Acceptance temp directories', async () => {
        const owned = await mkdtemp(join(tmpdir(), 'caxri-acceptance-user-'));
        const unowned = await mkdtemp(join(tmpdir(), 'caxri-unowned-user-'));
        await writeFile(join(owned, 'marker'), 'owned');
        await writeFile(join(unowned, 'marker'), 'unowned');

        try {
            await removeOwnedUserData({ ownedUserData: true, userDataDir: owned });
            await expect(access(owned)).rejects.toMatchObject({ code: 'ENOENT' });

            await removeOwnedUserData({ ownedUserData: true, userDataDir: unowned });
            await expect(access(unowned)).resolves.toBeUndefined();
        } finally {
            await rm(owned, { force: true, recursive: true });
            await rm(unowned, { force: true, recursive: true });
        }
    });

    it('owns an uppercase stable check id without normalizing it', async () => {
        const profile = await prepareAcceptanceUserData({
            caseId: 'MOB-SEC-01',
            cleanupReusable: false,
        });

        try {
            expect(profile.acceptanceCase).toMatchObject({
                id: 'MOB-SEC-01',
                mode: 'isolated',
            });
            expect(profile.userDataDir).toContain('-MOB-SEC-01-');
        } finally {
            await removeOwnedUserData(profile);
        }
    });

    it('reuses only prefixed temp profiles and cleans them up only when requested', async () => {
        const reusable = await mkdtemp(join(tmpdir(), 'caxri-acceptance-user-12-restart-case-'));
        const unsafe = await mkdtemp(join(tmpdir(), 'caxri-unowned-user-'));

        try {
            await expect(
                prepareAcceptanceUserData({
                    caseId: 'restart-case',
                    caseMode: 'restart',
                    cleanupReusable: false,
                    reuseUserDataDir: reusable,
                }),
            ).resolves.toMatchObject({ ownedUserData: false });
            await expect(
                prepareAcceptanceUserData({
                    caseId: 'restart-case',
                    caseMode: 'restart',
                    cleanupReusable: true,
                    reuseUserDataDir: unsafe,
                }),
            ).rejects.toThrow('Reusable Acceptance user data');
            await expect(prepareAcceptanceUserData({ cleanupReusable: true })).rejects.toThrow(
                '--cleanup-reused-user-data requires --reuse-user-data',
            );

            const finalLaunch = await prepareAcceptanceUserData({
                caseId: 'restart-case',
                caseMode: 'restart',
                cleanupReusable: true,
                reuseUserDataDir: reusable,
            });
            await removeOwnedUserData(finalLaunch);
            await expect(access(reusable)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(reusable, { force: true, recursive: true });
            await rm(unsafe, { force: true, recursive: true });
        }
    });

    it('rejects prefix-overlapping restart case identities', async () => {
        const reusable = await mkdtemp(
            join(tmpdir(), 'caxri-acceptance-user-16-settings-restart-'),
        );
        try {
            await expect(
                prepareAcceptanceUserData({
                    caseId: 'settings',
                    caseMode: 'restart',
                    cleanupReusable: false,
                    reuseUserDataDir: reusable,
                }),
            ).rejects.toThrow('Reusable Acceptance user data');
            await expect(
                prepareAcceptanceUserData({
                    caseId: 'settings-restart',
                    caseMode: 'restart',
                    cleanupReusable: false,
                    reuseUserDataDir: reusable,
                }),
            ).resolves.toMatchObject({
                acceptanceCase: { id: 'settings-restart', mode: 'restart' },
            });
        } finally {
            await rm(reusable, { force: true, recursive: true });
        }
    });

    it('keeps mutable cases order-independent and removes every owned profile', async () => {
        const profiles: Array<Awaited<ReturnType<typeof prepareAcceptanceUserData>>> = [];
        /**
         * This test asserts that processing caseIds in a given sequential order still yields the same order-independent
         * final state, so caseIds must actually be awaited in order here.
         */
        const runOrder = async (caseIds: string[]) => {
            const observations: string[] = [];
            for (const caseId of caseIds) {
                // eslint-disable-next-line no-await-in-loop
                const profile = await prepareAcceptanceUserData({
                    caseId,
                    cleanupReusable: false,
                });
                profiles.push(profile);
                const marker = join(profile.userDataDir, 'case-state.txt');
                // eslint-disable-next-line no-await-in-loop
                await writeFile(marker, caseId);
                // eslint-disable-next-line no-await-in-loop
                observations.push(await readFile(marker, 'utf8'));
            }
            return observations.toSorted((a, b) => a.localeCompare(b));
        };
        try {
            await expect(runOrder(['settings-case', 'session-case'])).resolves.toEqual([
                'session-case',
                'settings-case',
            ]);
            await expect(runOrder(['session-case', 'settings-case'])).resolves.toEqual([
                'session-case',
                'settings-case',
            ]);
            expect(new Set(profiles.map(({ userDataDir }) => userDataDir)).size).toBe(4);
            expect(profiles.every(({ acceptanceCase }) => acceptanceCase.mode === 'isolated')).toBe(
                true,
            );
            expect(
                profiles.every(
                    ({ acceptanceCase }) =>
                        acceptanceCase.requiresTerminalFixturePreflight === true,
                ),
            ).toBe(true);
        } finally {
            await Promise.all(profiles.map((profile) => removeOwnedUserData(profile)));
        }
        await Promise.all(
            profiles.map(({ userDataDir }) =>
                expect(access(userDataDir)).rejects.toMatchObject({ code: 'ENOENT' }),
            ),
        );
    });

    it('probes only a direct temp-directory child when checking a profile identity', async () => {
        for (const identity of ['', '.', '..', 'nested/profile', '/etc']) {
            // eslint-disable-next-line no-await-in-loop -- sequential assertions keep the failing identity readable
            await expect(isAcceptanceProfileIdentityRemoved(identity)).rejects.toThrow(
                'must be a directory name',
            );
        }
        await expect(
            isAcceptanceProfileIdentityRemoved(`caxri-acceptance-missing-${process.pid}`),
        ).resolves.toBe(true);
    });

    it('records an explicit non-Terminal frame-capture plan without weakening the default', async () => {
        const profile = await prepareAcceptanceUserData({
            caseId: 'non-terminal-recording',
            cleanupReusable: false,
            requiresTerminalFixturePreflight: false,
        });
        try {
            expect(profile.acceptanceCase.requiresTerminalFixturePreflight).toBe(false);
        } finally {
            await removeOwnedUserData(profile);
        }
    });
});

describe('runProcessProbe', () => {
    const timeoutKill = () =>
        Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });

    it('retries a timed-out attempt once with the longer timeout', async () => {
        const execute = vi
            .fn()
            .mockRejectedValueOnce(timeoutKill())
            .mockResolvedValueOnce({ stdout: 'p42\n' });

        await expect(
            runProcessProbe('path-owner', 'lsof', ['x'], { execute, timeoutsMs: [5, 9] }),
        ).resolves.toEqual({ stdout: 'p42\n' });
        expect(execute.mock.calls.map((call) => (call[2] as { timeout: number }).timeout)).toEqual([
            5, 9,
        ]);
    });

    it('classifies repeated timeouts as probe-timeout naming the probe and elapsed wait', async () => {
        const execute = vi.fn().mockRejectedValue(timeoutKill());

        let error: unknown;
        try {
            await runProcessProbe('path-owner', 'lsof', ['x'], { execute, timeoutsMs: [5, 9] });
        } catch (error_: unknown) {
            error = error_;
        }

        expect(error).toBeInstanceOf(ProcessProbeTimeoutError);
        expect(error).toMatchObject({ attempts: 2, code: 'probe-timeout', probe: 'path-owner' });
        expect((error as ProcessProbeTimeoutError).elapsedMs).toBeGreaterThanOrEqual(0);
        expect((error as Error).message).toContain('"path-owner"');
        expect(execute).toHaveBeenCalledTimes(2);
    });

    it('does not retry or reclassify a normal exit-1 no-owner result', async () => {
        const noOwner = Object.assign(new Error('exit 1'), { code: 1 });
        const execute = vi.fn().mockRejectedValue(noOwner);

        await expect(
            runProcessProbe('path-owner', 'lsof', ['x'], { execute, timeoutsMs: [5, 9] }),
        ).rejects.toBe(noOwner);
        expect(execute).toHaveBeenCalledTimes(1);
    });
});

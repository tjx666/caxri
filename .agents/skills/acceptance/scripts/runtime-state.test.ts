import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import {
    errorCode,
    getProcessIdentity,
    isAlive,
    isOwnedLauncher,
    isOwnedRuntime,
    prepareAcceptanceUserData,
    removeOwnedUserData,
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
                ownedUserData: true,
                port: 9222,
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
            expect(
                profiles.every(({ acceptanceCase }) => acceptanceCase?.mode === 'isolated'),
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
});

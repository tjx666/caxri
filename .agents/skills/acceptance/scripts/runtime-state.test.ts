import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
        expect(errorCode(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe('ENOENT');
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
        const reusable = await mkdtemp(join(tmpdir(), 'caxri-acceptance-user-restart-'));
        const unsafe = await mkdtemp(join(tmpdir(), 'caxri-unowned-user-'));

        try {
            await expect(
                prepareAcceptanceUserData({
                    cleanupReusable: false,
                    reuseUserDataDir: reusable,
                }),
            ).resolves.toMatchObject({ ownedUserData: false });
            await expect(
                prepareAcceptanceUserData({ cleanupReusable: true, reuseUserDataDir: unsafe }),
            ).rejects.toThrow('Reusable Acceptance user data');
            await expect(prepareAcceptanceUserData({ cleanupReusable: true })).rejects.toThrow(
                '--cleanup-reused-user-data requires --reuse-user-data',
            );

            const finalLaunch = await prepareAcceptanceUserData({
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
});

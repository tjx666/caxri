import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
    errorCode,
    getProcessIdentity,
    isAlive,
    isOwnedLauncher,
    removeOwnedUserData,
    runtimeStateSchema,
} from './runtime-state';

describe('Acceptance runtime ownership', () => {
    it('validates the ownership fields persisted by the launcher', () => {
        expect(
            runtimeStateSchema.parse({
                cdpUrl: 'http://127.0.0.1:9222',
                electronPid: 124,
                launcherIdentity: 'started-at command',
                launcherPid: 123,
                ownedUserData: true,
                port: 9222,
                startedAt: '2026-08-09T00:00:00.000Z',
                testRootPath: '/tmp/project',
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
});

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveServerProfilePaths } from '../../profile';
import type { ServerCore } from '../../server-core';
import { startServerCore } from '../../server-core';

const apps: ServerCore[] = [];
const directories: string[] = [];

afterEach(async () => {
    const appsToStop = apps.slice();
    apps.length = 0;
    await Promise.all(appsToStop.map((app) => app.stop('test-cleanup')));
    const directoriesToRemove = directories.slice();
    directories.length = 0;
    await Promise.all(
        directoriesToRemove.map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

describe('credential registry startup', () => {
    it('removes the legacy private credential files when the Server starts', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-server-mobile-legacy-'));
        directories.push(userDataPath);
        const paths = await resolveServerProfilePaths(userDataPath);
        await mkdir(paths.directory, { mode: 0o700 });
        const legacyFiles = ['mobile-devices.json', 'delegation-clients.json'].map((name) =>
            join(paths.directory, name),
        );
        await Promise.all(
            legacyFiles.map((file) =>
                writeFile(file, '{"version":1,"devices":[]}\n', { mode: 0o600 }),
            ),
        );

        const app = await startServerCore({ commit: 'test', userDataPath, version: '1.0.0' });
        apps.push(app);

        expect(app.lease.identity.profileId).toBe(paths.profileId);
        await Promise.all(
            legacyFiles.map((file) => expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })),
        );
    });
});

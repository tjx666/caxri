import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db';
import { resolveTerminalFileLink } from '../file-links';

const databases: CaxriDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDatabases = [...databases];
    databases.length = 0;
    for (const database of pendingDatabases) database.close();
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-terminal-file-link-trust-'));
    temporaryDirectories.push(temporary);
    const userHome = await realpath(temporary);
    const sourceRoot = join(userHome, 'source');
    await mkdir(sourceRoot);
    const database = new CaxriDatabase(join(userHome, 'state.db'));
    databases.push(database);
    const source = database.createSession(database.createProject(sourceRoot).id, 'shell');
    return {
        database,
        sourceSessionId: source.session.id,
        terminalId: source.terminal!.id,
        userHome,
    };
}

describe('resolveTerminalFileLink Trusted Folders', () => {
    it.each([
        ['absolute path', (path: string) => path],
        ['file URL', (path: string) => `file://${path}`],
    ])(
        'marks an external %s trusted only when a Trusted Folder contains it',
        async (_kind, toTarget) => {
            const { database, sourceSessionId, terminalId, userHome } = await fixture();
            const outsideTarget = join(userHome, '.example', 'secrets', 'runtime.json');

            await expect(
                resolveTerminalFileLink(
                    database,
                    { terminalId, target: toTarget(outsideTarget) },
                    { userHome, trustedFolders: [join(userHome, 'elsewhere')] },
                ),
            ).resolves.toEqual({
                status: 'external',
                path: outsideTarget,
                sourceSessionId,
                trusted: false,
            });
            await expect(
                resolveTerminalFileLink(
                    database,
                    { terminalId, target: toTarget(outsideTarget) },
                    { userHome, trustedFolders: [`${join(userHome, '.example')}/`] },
                ),
            ).resolves.toMatchObject({ status: 'external', trusted: true });
        },
    );

    it('matches a Trusted Folder through either spelling of an aliased ancestor', async () => {
        const { database, terminalId, userHome } = await fixture();
        const realFolder = join(userHome, 'real');
        const aliasFolder = join(userHome, 'alias');
        await mkdir(realFolder);
        await symlink(realFolder, aliasFolder);
        await writeFile(join(realFolder, 'a.png'), 'png');

        for (const [rule, target, untrusted] of [
            [realFolder, join(aliasFolder, 'a.png'), join(userHome, 'other')],
            [aliasFolder, join(realFolder, 'a.png'), join(userHome, 'other')],
        ] as const) {
            // eslint-disable-next-line no-await-in-loop -- two ordered alias directions
            await expect(
                resolveTerminalFileLink(
                    database,
                    { terminalId, target },
                    { userHome, trustedFolders: [rule] },
                ),
            ).resolves.toMatchObject({ status: 'external', path: target, trusted: true });
            // eslint-disable-next-line no-await-in-loop -- two ordered alias directions
            await expect(
                resolveTerminalFileLink(
                    database,
                    { terminalId, target },
                    { userHome, trustedFolders: [untrusted] },
                ),
            ).resolves.toMatchObject({ status: 'external', trusted: false });
        }
    });
});

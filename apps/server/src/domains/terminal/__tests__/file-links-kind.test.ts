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
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-terminal-file-link-kind-'));
    temporaryDirectories.push(temporary);
    const sourceRoot = join(await realpath(temporary), 'source');
    await mkdir(sourceRoot);
    const database = new CaxriDatabase(join(temporary, 'state.db'));
    databases.push(database);
    const source = database.createSession(database.createProject(sourceRoot).id, 'shell');
    return { database, sourceRoot, terminalId: source.terminal!.id };
}

describe('resolveTerminalFileLink target kind', () => {
    it('authorizes a directory inside the Project and reports its kind', async () => {
        const { database, sourceRoot, terminalId } = await fixture();
        const directory = join(sourceRoot, '.local-config');
        await mkdir(directory);

        await expect(
            resolveTerminalFileLink(database, { terminalId, target: directory }),
        ).resolves.toMatchObject({ status: 'authorized', kind: 'directory', path: directory });
    });

    it('authorizes a directory reached through a symlink inside the Project', async () => {
        const { database, sourceRoot, terminalId } = await fixture();
        const directory = join(sourceRoot, 'real-config');
        await mkdir(directory);
        await symlink(directory, join(sourceRoot, 'linked-config'));

        await expect(
            resolveTerminalFileLink(database, {
                terminalId,
                target: join(sourceRoot, 'linked-config'),
            }),
        ).resolves.toMatchObject({ status: 'authorized', kind: 'directory', path: directory });
    });

    it('reports an extensionless regular file as a file', async () => {
        const { database, sourceRoot, terminalId } = await fixture();
        const target = join(sourceRoot, 'Makefile');
        await writeFile(target, 'all:\n');

        await expect(
            resolveTerminalFileLink(database, { terminalId, target }),
        ).resolves.toMatchObject({ status: 'authorized', kind: 'file', path: target });
    });
});

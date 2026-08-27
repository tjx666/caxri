import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db';
import { resolveTerminalFileLink } from '../file-links';

const databases: CaxriDatabase[] = [];
const temporaryDirectories: string[] = [];

async function fixture() {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-terminal-file-link-'));
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

afterEach(async () => {
    const pendingDatabases = [...databases];
    databases.length = 0;
    for (const database of pendingDatabases) database.close();
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('resolveTerminalFileLink', () => {
    it('authorizes a regular Home file already contained by an added Project', async () => {
        const { database, sourceSessionId, terminalId, userHome } = await fixture();
        const projectRoot = join(userHome, 'project');
        const target = join(projectRoot, 'src', 'file.ts');
        await mkdir(join(projectRoot, 'src'), { recursive: true });
        await writeFile(target, 'export {};\n');
        const project = database.createProject(projectRoot);
        const [rootIdentity, targetIdentity] = await Promise.all([
            lstat(projectRoot, { bigint: true }),
            lstat(target, { bigint: true }),
        ]);

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: '~/project/src/file.ts' },
                { userHome },
            ),
        ).resolves.toEqual({
            status: 'authorized',
            identity: {
                device: targetIdentity.dev.toString(),
                inode: targetIdentity.ino.toString(),
                root: {
                    path: projectRoot,
                    device: rootIdentity.dev.toString(),
                    inode: rootIdentity.ino.toString(),
                },
            },
            path: target,
            projectId: project.id,
            sourceSessionId,
        });
    });

    it('requires user authorization outside added Projects without probing target existence', async () => {
        const { database, terminalId, userHome } = await fixture();

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: '~/not-yet-authorized/missing.ts' },
                { userHome },
            ),
        ).resolves.toMatchObject({
            status: 'authorization_required',
            path: join(userHome, 'not-yet-authorized', 'missing.ts'),
        });
    });

    it('authorizes only a user-selected root that contains the regular target', async () => {
        const { database, terminalId, userHome } = await fixture();
        const selectedRoot = join(userHome, 'selected');
        const otherRoot = join(userHome, 'other');
        const target = join(selectedRoot, 'file.ts');
        await Promise.all([mkdir(selectedRoot), mkdir(otherRoot)]);
        await writeFile(target, 'selected\n');

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: '~/selected/file.ts', selectedRoot },
                { userHome },
            ),
        ).resolves.toMatchObject({
            status: 'selection_authorized',
            path: target,
            rootPath: selectedRoot,
        });
        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: '~/selected/file.ts', selectedRoot: otherRoot },
                { userHome },
            ),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
    });

    it('denies a symlink that escapes an otherwise authorized Project root', async () => {
        const { database, terminalId, userHome } = await fixture();
        const projectRoot = join(userHome, 'project');
        const outsideRoot = join(userHome, 'outside');
        await Promise.all([mkdir(projectRoot), mkdir(outsideRoot)]);
        const outsideTarget = join(outsideRoot, 'secret.ts');
        await writeFile(outsideTarget, 'secret\n');
        await symlink(outsideTarget, join(projectRoot, 'linked.ts'));
        database.createProject(projectRoot);

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: '~/project/linked.ts' },
                { userHome },
            ),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
    });

    it('normalizes missing in-Project targets to a bounded not-found error', async () => {
        const { database, terminalId, userHome } = await fixture();
        const projectRoot = join(userHome, 'project');
        await mkdir(projectRoot);
        database.createProject(projectRoot);

        await expect(
            resolveTerminalFileLink(
                database,
                { terminalId, target: '~/project/missing.ts' },
                { userHome },
            ),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it.each(['~', '~/', '~other/file.ts', '$HOME/file.ts', '${HOME}/file.ts', '~/../file.ts'])(
        'rejects unsupported or escaping Home syntax: %s',
        async (target) => {
            const { database, terminalId, userHome } = await fixture();

            await expect(
                resolveTerminalFileLink(database, { terminalId, target }, { userHome }),
            ).rejects.toMatchObject({
                code: target === '~/../file.ts' ? 'PATH_DENIED' : 'VALIDATION',
            });
        },
    );
});

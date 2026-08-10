import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../db/repository';
import { ProjectRootResolver } from '../project-roots';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

describe('ProjectRootResolver', () => {
    it('rejects a Project root replaced between metadata validation and realpath', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-project-root-race-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const outside = join(directory, 'outside');
        await Promise.all([mkdir(root), mkdir(outside)]);
        await writeFile(join(outside, 'target.txt'), 'outside', 'utf8');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(database.createProject(root).id, 'shell').session;
        const resolver = new ProjectRootResolver(database, {
            beforeRootRealpath: async () => {
                await rename(root, `${root}-original`);
                await symlink(outside, root);
            },
        });

        try {
            await expect(
                resolver.resolveSessionPath(session.id, join(root, 'target.txt')),
            ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        } finally {
            database.close();
        }
    });
});

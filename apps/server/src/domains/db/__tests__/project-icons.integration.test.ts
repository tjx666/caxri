import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../repository';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('Project icon persistence', () => {
    it('persists and clears controlled metadata without changing Project identity', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-db-project-icon-'));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        const project = database.createProject(directory);

        expect(database.setProjectIcon(project.id, { name: 'database', color: 'warning' })).toEqual(
            { ...project, icon: { name: 'database', color: 'warning' } },
        );
        database.close();

        const reopened = new CaxriDatabase(databasePath);
        expect(reopened.getProject(project.id)).toEqual({
            ...project,
            icon: { name: 'database', color: 'warning' },
        });
        expect(reopened.setProjectIcon(project.id, null)).toEqual(project);
        reopened.close();
    });
});

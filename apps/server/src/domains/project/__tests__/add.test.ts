import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { CaxriDatabase } from '../../db';
import { addProjectFolder } from '../add';

describe('addProjectFolder', () => {
    it('adds a folder once by its canonical root and returns the same Project again', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-project-add-'));
        const database = new CaxriDatabase(join(directory, 'state.db'));
        onTestFinished(async () => {
            database.close();
            await rm(directory, { recursive: true, force: true });
        });
        const root = join(directory, 'repo');
        await mkdir(root);
        await symlink(root, join(directory, 'link'));
        const emit = vi.fn();

        const project = await addProjectFolder(database, emit, root);
        database.hideProject(project.id);
        const again = await addProjectFolder(database, emit, join(directory, 'link'));

        expect(again.id).toBe(project.id);
        expect(again.rootPath).toBe(await realpath(root));
        // Re-adding a hidden folder shows it again, as the Desktop's Open Folder does.
        expect(database.listVisibleProjects().map(({ id }) => id)).toContain(project.id);
        expect(emit).toHaveBeenCalledWith({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'project.create' },
        });
        await expect(addProjectFolder(database, emit, 'relative/repo')).rejects.toThrow(
            'absolute path',
        );
    });
});

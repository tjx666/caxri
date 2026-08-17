import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { omit } from 'es-toolkit';
import { afterEach, describe, expect, it } from 'vitest';

import {
    createEditorLayout,
    listLayoutPaths,
    splitEditorPath,
} from '../../../shared/editor-layout';
import { CaxriDatabase } from '../repository';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

/**
 * Editor split-layout persistence coverage for `CaxriDatabase`, split from `repo.integration.test.ts` to keep that
 * facade suite under the repository `max-lines` gate.
 */
describe('CaxriDatabase editor layout', () => {
    it('round-trips an Editor split layout alongside the Terminal layout', async () => {
        const directory = await temporaryDirectory('caxri-db-editor-layout-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, null);
        const state = database.getSessionState(created.session.id);
        const path = join(directory, 'a.ts');
        const editorLayout = createEditorLayout(path);

        database.updateSessionState({
            ...state,
            openTabs: [{ path, dirty: false }],
            activeTab: { kind: 'editor', path },
            editorLayout,
        });

        expect(database.getSessionState(created.session.id)).toMatchObject({ editorLayout });
        database.close();
    });

    it('derives a default Editor layout for state written before the field existed', async () => {
        const directory = await temporaryDirectory('caxri-db-editor-layout-legacy-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, null);
        // `getSessionState` on a fresh Session already backfills `editorLayout: {}`; drop it from the write so the
        // update simulates a row that predates the field entirely, letting only the derived default produce it.
        const state = omit(database.getSessionState(created.session.id), ['editorLayout']);
        const path = join(directory, 'a.ts');

        database.updateSessionState({
            ...state,
            openTabs: [{ path, dirty: false }],
            activeTab: { kind: 'editor', path },
        });

        expect(database.getSessionState(created.session.id)).toMatchObject({
            editorLayout: { root: { type: 'group', paths: [path], activePath: path } },
        });
        database.close();
    });

    it('remaps the persisted Editor split tree alongside openTabs and activeTab', async () => {
        const directory = await temporaryDirectory('caxri-db-editor-layout-remap-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(directory);
        const created = database.createSession(project.id, null);
        const previousDirectory = join(directory, 'source');
        const nextDirectory = join(directory, 'destination');
        const previousPath = join(previousDirectory, 'a.ts');
        const nextPath = join(nextDirectory, 'a.ts');
        const otherPath = join(directory, 'other.ts');
        let editorLayout = createEditorLayout(previousPath);
        editorLayout = splitEditorPath(
            editorLayout,
            otherPath,
            editorLayout.activeGroupId!,
            'right',
        );
        database.updateSessionState({
            ...database.getSessionState(created.session.id),
            openTabs: [
                { path: previousPath, dirty: false },
                { path: otherPath, dirty: false },
            ],
            activeTab: { kind: 'editor', path: previousPath },
            editorLayout,
        });

        expect(
            database.remapWorkbenchEditorState(
                project.id,
                'operation-1',
                previousDirectory,
                nextDirectory,
            ),
        ).toBe(1);

        const remapped = database.getSessionState(created.session.id);
        expect(remapped.editorLayout && listLayoutPaths(remapped.editorLayout)).toEqual([
            nextPath,
            otherPath,
        ]);
        expect(remapped).toMatchObject({
            openTabs: [
                { path: nextPath, dirty: false },
                { path: otherPath, dirty: false },
            ],
            activeTab: { kind: 'editor', path: nextPath },
            editorRemapOperationId: 'operation-1',
        });
        database.close();
    });
});

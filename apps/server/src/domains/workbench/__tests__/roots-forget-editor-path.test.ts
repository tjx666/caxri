import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { listPaneTabs, openResource } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { CaxriDatabase } from '../../db/repository';
import { fixture } from './roots.fixture';

function filePaths(database: CaxriDatabase, sessionId: string): string[] {
    return listPaneTabs(database.getSessionState(sessionId).paneLayout).flatMap(({ tab }) =>
        tab.resource.kind === 'file' ? [tab.resource.path] : [],
    );
}

function openFile(database: CaxriDatabase, sessionId: string, path: string): void {
    const state = database.getSessionState(sessionId);
    database.updateSessionState({
        ...state,
        paneLayout: openResource(state.paneLayout, { kind: 'file', path }),
    });
}

describe('WorkbenchRootService.forgetEditorPath', () => {
    it('clears a trashed path from a Root the Session has left and refuses an unrelated Root', async () => {
        const context = await fixture();
        const { database, owner, ownerRoot, service, worktreeRoot } = context;
        const sessionId = context.sessions[0].session.id;
        const worktree = database.createProject(worktreeRoot);
        const unrelated = database.createProject(context.directory);
        const trashed = join(ownerRoot, 'src');
        openFile(database, sessionId, join(trashed, 'entry.ts'));
        openFile(database, sessionId, join(ownerRoot, 'kept.ts'));
        const identity = await lstat(worktreeRoot, { bigint: true });
        database.selectWorkbenchProject(sessionId, worktree.id, {
            device: identity.dev.toString(),
            inode: identity.ino.toString(),
        });

        // The Session now shows the worktree Root, so only the Server still holds the owner Root's layout.
        service.forgetEditorPath(sessionId, owner.id, trashed);

        database.selectWorkbenchProject(sessionId, owner.id);
        expect(filePaths(database, sessionId)).toEqual([join(ownerRoot, 'kept.ts')]);

        // A Renderer may only name the Session's owner Root or the one it is showing.
        expect(() =>
            service.forgetEditorPath(sessionId, unrelated.id, join(trashed, 'x.ts')),
        ).toThrow(/not selected by this Session/);
        // Containment is checked against the named Root, not the Session's current one.
        expect(() =>
            service.forgetEditorPath(sessionId, owner.id, join(worktreeRoot, 'x.ts')),
        ).toThrow(/outside the Workbench Root/);
        // `relative()` would resolve a relative argument against the Server's cwd, so containment needs an absolute path.
        expect(() => service.forgetEditorPath(sessionId, owner.id, 'src/entry.ts')).toThrow(
            /must be absolute/,
        );
        // The root can never be trashed, and accepting it would clear every stored document tab in one call.
        expect(() => service.forgetEditorPath(sessionId, owner.id, ownerRoot)).toThrow(
            /Root itself cannot be trashed/,
        );
        await service.close();
        database.close();
    });
});

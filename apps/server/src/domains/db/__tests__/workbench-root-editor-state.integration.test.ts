import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { PaneLayout } from '@caxri/protocol';
import {
    activeTab as activePaneTab,
    listPaneTabs,
    listPaneTerminalIds,
    openResource,
} from '@caxri/protocol';
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

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

function filePaths(layout: PaneLayout): string[] {
    return listPaneTabs(layout)
        .filter((occurrence) => occurrence.tab.resource.kind === 'file')
        .map((occurrence) => (occurrence.tab.resource as { kind: 'file'; path: string }).path);
}

function activeFilePath(layout: PaneLayout): string | undefined {
    const tab = activePaneTab(layout);
    return tab?.resource.kind === 'file' ? tab.resource.path : undefined;
}

interface StoredRootState {
    editorRemapOperationId?: string;
    extensionTreeViewStates?: unknown;
    sourceControlViewStates?: unknown;
    paneLayout: PaneLayout;
}

function readStoredRootStates(
    database: CaxriDatabase,
    sessionId: string,
): Record<string, StoredRootState> {
    const row = database.database
        .prepare('SELECT roots_json AS rootsJson FROM session_views WHERE session_id = ?')
        .get(sessionId) as { rootsJson: string };
    return JSON.parse(row.rootsJson) as Record<string, StoredRootState>;
}

/**
 * Coverage for how `CaxriDatabase` scopes a Session's durable editor state (open document tabs, active tab, and remaps)
 * per Workbench Root while keeping owner identity and Terminal cwd global. See `./repo.integration.test.ts` for the
 * rest of the facade-level wiring; `./database.integration.test.ts` for pure-SQL/schema behavior.
 */
describe('CaxriDatabase Workbench Root editor state', () => {
    it('heals historical orphan Terminal tabs per Root without dropping extension tree state', async () => {
        const directory = await temporaryDirectory('caxri-db-orphan-terminal-heal-');
        const databasePath = join(directory, 'state.db');
        const ownerRoot = join(directory, 'owner');
        const worktreeRoot = join(directory, 'worktree');
        await Promise.all([mkdir(ownerRoot), mkdir(worktreeRoot)]);
        const database = new CaxriDatabase(databasePath);
        const owner = database.createProject(ownerRoot);
        const worktree = database.createProject(worktreeRoot);
        const created = database.createSession(owner.id, 'shell');
        const orphan = database.createTerminal(created.session.id, 'shell');
        const worktreeIdentity = await lstat(worktreeRoot, { bigint: true });
        const ownerTreeState = {
            'publisher.fixture.owner': {
                expandedItemIds: ['owner-root'],
                focusedItemId: 'owner-root',
                initializedItemIds: ['owner-root'],
            },
        };
        const worktreeTreeState = {
            'publisher.fixture.worktree': {
                expandedItemIds: ['worktree-root'],
                focusedItemId: 'worktree-root',
                initializedItemIds: ['worktree-root'],
            },
        };
        const ownerSourceControlState = {
            'caxri.git.sourceControl': {
                expandedDirectories: {},
                expandedGroups: { owner: false },
                expandedProviders: {},
            },
        };
        const worktreeSourceControlState = {
            'caxri.git.sourceControl': {
                expandedDirectories: {},
                expandedGroups: { worktree: false },
                expandedProviders: {},
            },
        };

        database.updateSessionState({
            ...database.getSessionState(created.session.id),
            editorRemapOperationId: 'owner-operation',
            extensionTreeViewStates: ownerTreeState,
            sourceControlViewStates: ownerSourceControlState,
        });
        database.selectWorkbenchProject(created.session.id, worktree.id, {
            device: worktreeIdentity.dev.toString(),
            inode: worktreeIdentity.ino.toString(),
        });
        database.updateSessionState({
            ...database.getSessionState(created.session.id),
            editorRemapOperationId: 'worktree-operation',
            extensionTreeViewStates: worktreeTreeState,
            sourceControlViewStates: worktreeSourceControlState,
        });
        const historicalState = database.database
            .prepare('SELECT roots_json AS rootsJson FROM session_views WHERE session_id = ?')
            .get(created.session.id) as { rootsJson: string };

        database.closeTerminal(orphan.id);
        database.database
            .prepare('UPDATE session_views SET roots_json = ? WHERE session_id = ?')
            .run(historicalState.rootsJson, created.session.id);

        const healedWorktree = database.getSessionState(created.session.id);
        expect(listPaneTerminalIds(healedWorktree.paneLayout)).toEqual([created.terminal!.id]);
        expect(healedWorktree.extensionTreeViewStates).toEqual(worktreeTreeState);
        expect(healedWorktree.sourceControlViewStates).toEqual(worktreeSourceControlState);
        expect(healedWorktree.editorRemapOperationId).toBe('worktree-operation');

        const afterWorktreeRead = readStoredRootStates(database, created.session.id);
        expect(listPaneTerminalIds(afterWorktreeRead[worktree.id].paneLayout)).toEqual([
            created.terminal!.id,
        ]);
        expect(afterWorktreeRead[worktree.id].extensionTreeViewStates).toEqual(worktreeTreeState);
        expect(afterWorktreeRead[worktree.id].sourceControlViewStates).toEqual(
            worktreeSourceControlState,
        );
        expect(listPaneTerminalIds(afterWorktreeRead[owner.id].paneLayout)).toContain(orphan.id);
        expect(afterWorktreeRead[owner.id].extensionTreeViewStates).toEqual(ownerTreeState);
        expect(afterWorktreeRead[owner.id].sourceControlViewStates).toEqual(
            ownerSourceControlState,
        );

        database.selectWorkbenchProject(created.session.id, owner.id);
        const healedOwner = database.getSessionState(created.session.id);
        expect(listPaneTerminalIds(healedOwner.paneLayout)).toEqual([created.terminal!.id]);
        expect(healedOwner.extensionTreeViewStates).toEqual(ownerTreeState);
        expect(healedOwner.sourceControlViewStates).toEqual(ownerSourceControlState);
        expect(healedOwner.editorRemapOperationId).toBe('owner-operation');
        const afterOwnerRead = readStoredRootStates(database, created.session.id);
        expect(listPaneTerminalIds(afterOwnerRead[owner.id].paneLayout)).toEqual([
            created.terminal!.id,
        ]);
        expect(afterOwnerRead[worktree.id].extensionTreeViewStates).toEqual(worktreeTreeState);
        expect(afterOwnerRead[worktree.id].sourceControlViewStates).toEqual(
            worktreeSourceControlState,
        );
        database.close();

        const reopened = new CaxriDatabase(databasePath);
        const persisted = reopened.getSessionState(created.session.id);
        expect(listPaneTerminalIds(persisted.paneLayout)).toEqual([created.terminal!.id]);
        expect(persisted.extensionTreeViewStates).toEqual(ownerTreeState);
        expect(persisted.sourceControlViewStates).toEqual(ownerSourceControlState);
        reopened.close();
    });

    it('keeps owner identity and Terminal placement global while restoring editor state per Workbench Root', async () => {
        const directory = await temporaryDirectory('caxri-db-workbench-root-');
        const ownerRoot = join(directory, 'owner');
        const worktreeRoot = join(directory, 'worktree');
        await Promise.all([mkdir(ownerRoot), mkdir(worktreeRoot)]);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const owner = database.createProject(ownerRoot);
        const worktree = database.createProject(worktreeRoot);
        const created = database.createSession(owner.id, 'shell');
        const ownerState = database.getSessionState(created.session.id);
        database.updateSessionState({
            ...ownerState,
            paneLayout: openResource(ownerState.paneLayout, {
                kind: 'file',
                path: join(ownerRoot, 'owner.ts'),
            }),
        });
        const identity = await lstat(worktreeRoot, { bigint: true });

        database.selectWorkbenchProject(created.session.id, worktree.id, {
            device: identity.dev.toString(),
            inode: identity.ino.toString(),
        });

        expect(database.getSession(created.session.id)).toMatchObject({
            projectId: owner.id,
            workbenchRootProjectId: worktree.id,
            rootPath: worktreeRoot,
        });
        const freshWorktreeState = database.getSessionState(created.session.id);
        expect(freshWorktreeState.workbenchRootProjectId).toBe(worktree.id);
        // A first visit must persist its layout identity before another bootstrap reads it.
        expect(database.getSessionState(created.session.id).paneLayout).toEqual(
            freshWorktreeState.paneLayout,
        );
        expect(filePaths(freshWorktreeState.paneLayout)).toEqual([]);
        // The worktree root has never been arranged, so the Session's own Terminal still shows.
        expect(listPaneTerminalIds(freshWorktreeState.paneLayout)).toEqual([created.terminal!.id]);
        const worktreeState = database.getSessionState(created.session.id);
        database.updateSessionState({
            ...worktreeState,
            paneLayout: openResource(worktreeState.paneLayout, {
                kind: 'file',
                path: join(worktreeRoot, 'worktree.ts'),
            }),
        });
        const laterTerminal = database.createTerminal(created.session.id, 'shell');
        // The repository fallback remains the owning Project; Server Core supplies the active Workbench Root.
        expect(laterTerminal.cwd).toBe(ownerRoot);

        database.selectWorkbenchProject(created.session.id, owner.id);
        const restoredOwnerState = database.getSessionState(created.session.id);
        expect(restoredOwnerState.workbenchRootProjectId).toBe(owner.id);
        expect(filePaths(restoredOwnerState.paneLayout)).toEqual([join(ownerRoot, 'owner.ts')]);
        expect(activeFilePath(restoredOwnerState.paneLayout)).toBe(join(ownerRoot, 'owner.ts'));
        // The owner root was already arranged when `laterTerminal` was created on the worktree root, so it
        // must still surface here: Terminal placement is Session-global, not scoped to one Root.
        expect(listPaneTerminalIds(restoredOwnerState.paneLayout)).toEqual(
            expect.arrayContaining([created.terminal!.id, laterTerminal.id]),
        );
        expect(() => database.updateSessionState(worktreeState)).toThrow(/stale Workbench Root/);

        database.selectWorkbenchProject(created.session.id, worktree.id, {
            device: identity.dev.toString(),
            inode: identity.ino.toString(),
        });
        const restoredWorktreeState = database.getSessionState(created.session.id);
        expect(restoredWorktreeState.workbenchRootProjectId).toBe(worktree.id);
        expect(filePaths(restoredWorktreeState.paneLayout)).toEqual([
            join(worktreeRoot, 'worktree.ts'),
        ]);
        expect(activeFilePath(restoredWorktreeState.paneLayout)).toBe(
            join(worktreeRoot, 'worktree.ts'),
        );
        // `laterTerminal` was created on this very Root, so it stays alongside the Session's original Terminal.
        expect(listPaneTerminalIds(restoredWorktreeState.paneLayout)).toEqual(
            expect.arrayContaining([created.terminal!.id, laterTerminal.id]),
        );

        const statesBeforeDelete = readStoredRootStates(database, created.session.id);
        database.deleteProject(worktree.id);
        expect(database.getSession(created.session.id)).toMatchObject({
            projectId: owner.id,
            workbenchRootProjectId: owner.id,
            rootPath: ownerRoot,
        });
        expect(database.getTerminal(created.terminal!.id)).toMatchObject({
            cwd: ownerRoot,
            id: created.terminal!.id,
        });
        const statesAfterDelete = readStoredRootStates(database, created.session.id);
        expect(statesAfterDelete[owner.id]).toEqual(statesBeforeDelete[owner.id]);
        expect(statesAfterDelete[worktree.id]).toBeUndefined();
        database.close();
    });

    it('prunes a deleted Project before validating an oversized historical Root map', async () => {
        const directory = await temporaryDirectory('caxri-db-workbench-root-prune-');
        const ownerRoot = join(directory, 'owner');
        const deletedRoot = join(directory, 'deleted');
        await Promise.all([mkdir(ownerRoot), mkdir(deletedRoot)]);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const owner = database.createProject(ownerRoot);
        const deleted = database.createProject(deletedRoot);
        const created = database.createSession(owner.id, 'shell');
        const ownerState = readStoredRootStates(database, created.session.id)[owner.id];
        const historicalStates: Record<string, StoredRootState> = { [owner.id]: ownerState };
        for (let index = 0; index < 1_023; index += 1)
            historicalStates[`historical-${index}`] = ownerState;
        historicalStates[deleted.id] = ownerState;
        database.database
            .prepare('UPDATE session_views SET roots_json = ? WHERE session_id = ?')
            .run(JSON.stringify(historicalStates), created.session.id);

        database.deleteProject(deleted.id);

        const retainedStates = readStoredRootStates(database, created.session.id);
        const expectedStates = { ...historicalStates };
        delete expectedStates[deleted.id];
        expect(retainedStates).toEqual(expectedStates);
        expect(Object.keys(retainedStates)).toHaveLength(1_024);
        database.close();
    });

    it('keeps Terminal placement in sync across every already-arranged Workbench Root', async () => {
        const directory = await temporaryDirectory('caxri-db-terminal-cross-root-');
        const ownerRoot = join(directory, 'owner');
        const worktreeRoot = join(directory, 'worktree');
        await Promise.all([mkdir(ownerRoot), mkdir(worktreeRoot)]);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const owner = database.createProject(ownerRoot);
        const worktree = database.createProject(worktreeRoot);
        const created = database.createSession(owner.id, 'shell');
        const identity = await lstat(worktreeRoot, { bigint: true });

        // Arrange the owner root so it gets its own stored snapshot, then do the same for the
        // worktree root: both Roots are now "already arranged" and stop refreshing from `terminals`.
        const ownerState = database.getSessionState(created.session.id);
        database.updateSessionState({
            ...ownerState,
            paneLayout: openResource(ownerState.paneLayout, {
                kind: 'file',
                path: join(ownerRoot, 'owner.ts'),
            }),
        });
        database.selectWorkbenchProject(created.session.id, worktree.id, {
            device: identity.dev.toString(),
            inode: identity.ino.toString(),
        });
        const worktreeState = database.getSessionState(created.session.id);
        database.updateSessionState({
            ...worktreeState,
            paneLayout: openResource(worktreeState.paneLayout, {
                kind: 'file',
                path: join(worktreeRoot, 'worktree.ts'),
            }),
        });

        // Creating a Terminal while the worktree root is selected must still surface it once the
        // owner root's stored snapshot is revisited, not only in the Root that was active at creation.
        const secondTerminal = database.createTerminal(created.session.id, 'shell');
        database.selectWorkbenchProject(created.session.id, owner.id);
        const ownerAfterCreate = database.getSessionState(created.session.id);
        expect(listPaneTerminalIds(ownerAfterCreate.paneLayout)).toEqual(
            expect.arrayContaining([created.terminal!.id, secondTerminal.id]),
        );

        // Closing a Terminal from the owner root must drop it from the worktree root's stored
        // snapshot too, instead of leaving a ghost tab pointing at a PTY that no longer exists.
        database.closeTerminal(secondTerminal.id);
        database.selectWorkbenchProject(created.session.id, worktree.id, {
            device: identity.dev.toString(),
            inode: identity.ino.toString(),
        });
        const worktreeAfterClose = database.getSessionState(created.session.id);
        expect(listPaneTerminalIds(worktreeAfterClose.paneLayout)).toEqual([created.terminal!.id]);
        database.close();
    });

    it('remaps durable editor state for an inactive Workbench Root idempotently', async () => {
        const directory = await temporaryDirectory('caxri-db-inactive-root-remap-');
        const ownerRoot = join(directory, 'owner');
        const worktreeRoot = join(directory, 'worktree');
        await Promise.all([mkdir(ownerRoot), mkdir(worktreeRoot)]);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const owner = database.createProject(ownerRoot);
        const worktree = database.createProject(worktreeRoot);
        const created = database.createSession(owner.id, 'shell');
        const identity = await lstat(worktreeRoot, { bigint: true });
        database.selectWorkbenchProject(created.session.id, worktree.id, {
            device: identity.dev.toString(),
            inode: identity.ino.toString(),
        });
        const previousDirectory = join(worktreeRoot, 'source');
        const nextDirectory = join(worktreeRoot, 'destination');
        const previousPath = join(previousDirectory, 'document.ts');
        const nextPath = join(nextDirectory, 'document.ts');
        const gitDiffPath = 'caxri-git-diff://file/repository/source%2Fdocument.ts';
        const beforeRemapState = database.getSessionState(created.session.id);
        const openedGitDiff = openResource(beforeRemapState.paneLayout, {
            kind: 'file',
            path: gitDiffPath,
        });
        const openedPrevious = openResource(openedGitDiff, { kind: 'file', path: previousPath });
        database.updateSessionState({ ...beforeRemapState, paneLayout: openedPrevious });
        database.selectWorkbenchProject(created.session.id, owner.id);

        expect(
            database.remapWorkbenchEditorState(
                worktree.id,
                'operation-1',
                previousDirectory,
                nextDirectory,
            ),
        ).toBe(1);
        const ownerStateAfterRemap = database.getSessionState(created.session.id);
        expect(ownerStateAfterRemap.workbenchRootProjectId).toBe(owner.id);
        expect(filePaths(ownerStateAfterRemap.paneLayout)).toEqual([]);

        database.selectWorkbenchProject(created.session.id, worktree.id, {
            device: identity.dev.toString(),
            inode: identity.ino.toString(),
        });
        const remapped = database.getSessionState(created.session.id);
        expect(remapped.workbenchRootProjectId).toBe(worktree.id);
        expect(filePaths(remapped.paneLayout)).toEqual([gitDiffPath, nextPath]);
        expect(activeFilePath(remapped.paneLayout)).toBe(nextPath);
        expect(remapped.editorRemapOperationId).toBe('operation-1');
        expect(
            database.remapWorkbenchEditorState(
                worktree.id,
                'operation-1',
                previousDirectory,
                nextDirectory,
            ),
        ).toBe(0);
        expect(database.getSessionState(created.session.id)).toEqual(remapped);
        database.close();
    });

    it('leaves virtual editor tabs untouched when the remap source covers the process cwd', async () => {
        const directory = await temporaryDirectory('caxri-db-virtual-tab-remap-');
        const ownerRoot = join(directory, 'owner');
        await mkdir(ownerRoot);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const owner = database.createProject(ownerRoot);
        const created = database.createSession(owner.id, 'shell');
        const transcriptPath = 'caxri-agent-transcript://terminal-1/Claude%20Code';
        const state = database.getSessionState(created.session.id);
        database.updateSessionState({
            ...state,
            paneLayout: openResource(state.paneLayout, { kind: 'file', path: transcriptPath }),
        });

        // A virtual tab path is not absolute, so without the scheme exemption `relative()` would
        // resolve it against the process cwd; a remap whose source covers the cwd would then
        // rewrite the tab into a bogus filesystem path. The count still reports 1: it counts
        // Sessions stamped with the operation, not changed paths.
        expect(
            database.remapWorkbenchEditorState(
                owner.id,
                'operation-1',
                process.cwd(),
                join(directory, 'moved'),
            ),
        ).toBe(1);
        expect(filePaths(database.getSessionState(created.session.id).paneLayout)).toEqual([
            transcriptPath,
        ]);
        database.close();
    });

    it('forgets a trashed path in a Workbench Root the Session is no longer showing', async () => {
        const directory = await temporaryDirectory('caxri-db-trash-forget-editor-');
        const ownerRoot = join(directory, 'owner');
        const worktreeRoot = join(directory, 'worktree');
        await Promise.all([mkdir(ownerRoot), mkdir(worktreeRoot)]);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const owner = database.createProject(ownerRoot);
        const worktree = database.createProject(worktreeRoot);
        const created = database.createSession(owner.id, 'shell');
        const trashedDirectory = join(ownerRoot, 'src');
        const nestedPath = join(trashedDirectory, 'nested', 'deep.ts');
        const directPath = join(trashedDirectory, 'entry.ts');
        const survivingPath = join(ownerRoot, 'source.ts');
        // Shares the trashed directory's name as a string prefix while being a sibling, not a descendant.
        const siblingPath = join(ownerRoot, 'src-extra', 'kept.ts');
        const transcriptPath = 'caxri-agent-transcript://terminal-1/Claude%20Code';
        const ownerState = database.getSessionState(created.session.id);
        database.updateSessionState({
            ...ownerState,
            paneLayout: [survivingPath, siblingPath, transcriptPath, directPath, nestedPath].reduce(
                (layout, path) => openResource(layout, { kind: 'file', path }),
                ownerState.paneLayout,
            ),
        });
        const identity = await lstat(worktreeRoot, { bigint: true });
        database.selectWorkbenchProject(created.session.id, worktree.id, {
            device: identity.dev.toString(),
            inode: identity.ino.toString(),
        });
        const worktreePath = join(worktreeRoot, 'src', 'entry.ts');
        const worktreeState = database.getSessionState(created.session.id);
        // The same relative path under the other Root; only the named Root may lose its tab.
        database.updateSessionState({
            ...worktreeState,
            paneLayout: openResource(worktreeState.paneLayout, {
                kind: 'file',
                path: worktreePath,
            }),
        });
        const statesBeforeTrash = readStoredRootStates(database, created.session.id);

        expect(database.removeWorkbenchEditorPath(owner.id, trashedDirectory)).toBe(1);

        const statesAfterTrash = readStoredRootStates(database, created.session.id);
        expect(filePaths(statesAfterTrash[owner.id].paneLayout)).toEqual([
            survivingPath,
            siblingPath,
            transcriptPath,
        ]);
        expect(statesAfterTrash[worktree.id]).toEqual(statesBeforeTrash[worktree.id]);
        // The Session is still parked on the worktree Root, so the state it reads back is untouched.
        expect(filePaths(database.getSessionState(created.session.id).paneLayout)).toEqual([
            worktreePath,
        ]);

        // A trashed file closes only its own tab, and a repeat over an already-cleaned path changes nothing.
        expect(database.removeWorkbenchEditorPath(owner.id, survivingPath)).toBe(1);
        expect(database.removeWorkbenchEditorPath(owner.id, trashedDirectory)).toBe(0);
        expect(
            filePaths(readStoredRootStates(database, created.session.id)[owner.id].paneLayout),
        ).toEqual([siblingPath, transcriptPath]);
        database.close();
    });
});

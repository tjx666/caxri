import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { omit } from 'es-toolkit';
import { afterEach, describe, expect, it } from 'vitest';

import {
    createEditorLayout,
    listLayoutPaths,
    splitEditorPath,
} from '../../../shared/editor-layout';
import { listLayoutTerminalIds, splitTerminal } from '../../../shared/terminal-layout';
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
 * Facade-level coverage for `CaxriDatabase`: proves that `../index` (pure SQL) and `../../session-policy` (pure
 * decisions) are wired together correctly inside one transaction per operation. Pure-SQL/schema behavior lives in
 * `./database.integration.test.ts`; pure-decision behavior lives in `../../session-policy.test.ts`.
 */
describe('CaxriDatabase', () => {
    it.each([
        ['shell', 'Shell'],
        ['claude', 'Claude Code'],
        ['codex', 'Codex'],
    ] as const)(
        'starts a new %s Session as Untitled with a provider-specific Terminal title',
        async (kind, terminalTitle) => {
            const directory = await temporaryDirectory(`caxri-db-untitled-${kind}-`);
            const database = new CaxriDatabase(join(directory, 'state.db'));
            const created = database.createSession(database.createProject(directory).id, kind);

            expect(created.session).toMatchObject({
                displayTitle: 'Untitled',
                titleMode: 'automatic',
            });
            expect(created.terminal!.title).toBe(terminalTitle);
            database.close();
        },
    );

    it('creates a Terminal-less Session with an empty layout when kind is null', async () => {
        const directory = await temporaryDirectory('caxri-db-no-terminal-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, null);

        expect(created.terminal).toBeNull();
        expect(created.session).toMatchObject({
            displayTitle: 'Untitled',
            primaryAgentTerminalId: undefined,
        });
        expect(database.getSessionState(created.session.id)).toMatchObject({ layout: {} });
        database.close();
    });

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

    it('persists manual Session title ownership across metadata resets and reopen', async () => {
        const directory = await temporaryDirectory('caxri-db-session-rename-');
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        const created = database.createSession(database.createProject(directory).id, 'codex');

        expect(database.renameSession(created.session.id, '  Manual name  ')).toMatchObject({
            displayTitle: 'Manual name',
            titleMode: 'manual',
        });
        database.resetAgentMetadataForStart(created.terminal!.id);
        expect(database.getSession(created.session.id)).toMatchObject({
            displayTitle: 'Manual name',
            titleMode: 'manual',
        });
        database.close();

        const reopened = new CaxriDatabase(databasePath);
        expect(reopened.getSession(created.session.id)).toMatchObject({
            displayTitle: 'Manual name',
            titleMode: 'manual',
        });
        reopened.close();
    });

    it('groups Sessions with the same root under one Project', async () => {
        const directory = await temporaryDirectory('caxri-db-project-grouping-');
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));

        const project = database.createProject(root);
        const first = database.createSession(project.id, 'shell');
        const second = database.createSession(project.id, 'codex');

        expect(database.listSessions()).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: first.session.id,
                    projectId: project.id,
                    rootPath: root,
                }),
                expect.objectContaining({
                    id: second.session.id,
                    projectId: project.id,
                    rootPath: root,
                }),
            ]),
        );
        expect(database.listSessions()).toHaveLength(2);
        database.close();
    });

    it('keeps owner identity and Terminal cwd global while restoring editor state per Workbench Root', async () => {
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
            openTabs: [{ path: join(ownerRoot, 'owner.ts'), dirty: false }],
            activeTab: { kind: 'editor', path: join(ownerRoot, 'owner.ts') },
        });
        const identity = await lstat(worktreeRoot, { bigint: true });

        database.selectWorkbenchProject(created.session.id, worktree.id, {
            device: identity.dev.toString(),
            inode: identity.ino.toString(),
        });

        expect(database.getSession(created.session.id)).toMatchObject({
            projectId: owner.id,
            workbenchProjectId: worktree.id,
            rootPath: worktreeRoot,
        });
        expect(database.getSessionState(created.session.id)).toMatchObject({
            workbenchProjectId: worktree.id,
            openTabs: [],
        });
        const worktreeState = database.getSessionState(created.session.id);
        database.updateSessionState({
            ...worktreeState,
            openTabs: [{ path: join(worktreeRoot, 'worktree.ts'), dirty: true }],
            activeTab: { kind: 'editor', path: join(worktreeRoot, 'worktree.ts') },
        });
        const laterTerminal = database.createTerminal(created.session.id, 'shell');
        expect(laterTerminal.cwd).toBe(ownerRoot);

        database.selectWorkbenchProject(created.session.id, owner.id);
        expect(database.getSessionState(created.session.id)).toMatchObject({
            workbenchProjectId: owner.id,
            openTabs: [{ path: join(ownerRoot, 'owner.ts'), dirty: false }],
            activeTab: { kind: 'editor', path: join(ownerRoot, 'owner.ts') },
        });
        expect(() => database.updateSessionState(worktreeState)).toThrow(/stale Workbench Root/);

        database.selectWorkbenchProject(created.session.id, worktree.id, {
            device: identity.dev.toString(),
            inode: identity.ino.toString(),
        });
        expect(database.getSessionState(created.session.id)).toMatchObject({
            workbenchProjectId: worktree.id,
            openTabs: [{ path: join(worktreeRoot, 'worktree.ts'), dirty: false }],
            activeTab: { kind: 'editor', path: join(worktreeRoot, 'worktree.ts') },
        });

        database.deleteProject(worktree.id);
        expect(database.getSession(created.session.id)).toMatchObject({
            projectId: owner.id,
            workbenchProjectId: owner.id,
            rootPath: ownerRoot,
        });
        expect(database.getTerminal(created.terminal!.id)).toMatchObject({
            cwd: ownerRoot,
            id: created.terminal!.id,
        });
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
        database.updateSessionState({
            ...database.getSessionState(created.session.id),
            openTabs: [
                { path: previousPath, dirty: false },
                { path: gitDiffPath, dirty: false },
            ],
            activeTab: { kind: 'editor', path: previousPath },
        });
        database.selectWorkbenchProject(created.session.id, owner.id);

        expect(
            database.remapWorkbenchEditorState(
                worktree.id,
                'operation-1',
                previousDirectory,
                nextDirectory,
            ),
        ).toBe(1);
        expect(database.getSessionState(created.session.id)).toMatchObject({
            workbenchProjectId: owner.id,
            openTabs: [],
        });

        database.selectWorkbenchProject(created.session.id, worktree.id, {
            device: identity.dev.toString(),
            inode: identity.ino.toString(),
        });
        const remapped = database.getSessionState(created.session.id);
        expect(remapped).toMatchObject({
            workbenchProjectId: worktree.id,
            openTabs: [
                { path: nextPath, dirty: false },
                { path: gitDiffPath, dirty: false },
            ],
            activeTab: { kind: 'editor', path: nextPath },
            editorRemapOperationId: 'operation-1',
        });
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

    it('keeps Project and Session ordering stable when a Session is selected', async () => {
        const directory = await temporaryDirectory('caxri-db-stable-selection-order-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const firstProject = database.createProject(join(directory, 'first'));
        const firstSession = database.createSession(firstProject.id, 'shell');
        const secondSession = database.createSession(firstProject.id, 'codex');
        const secondProject = database.createProject(join(directory, 'second'));
        database.createSession(secondProject.id, 'shell');

        database.database
            .prepare('UPDATE projects SET created_at = ?, last_opened_at = ? WHERE id = ?')
            .run(1, 1, firstProject.id);
        database.database
            .prepare('UPDATE projects SET created_at = ?, last_opened_at = ? WHERE id = ?')
            .run(2, 2, secondProject.id);
        database.database
            .prepare('UPDATE sessions SET created_at = ?, last_opened_at = ? WHERE id = ?')
            .run(1, 1, firstSession.session.id);
        database.database
            .prepare('UPDATE sessions SET created_at = ?, last_opened_at = ? WHERE id = ?')
            .run(2, 2, secondSession.session.id);

        const projectOrder = database.listProjects().map((project) => project.id);
        const sessionOrder = database.listSessions(firstProject.id).map((session) => session.id);

        database.selectSession(firstSession.session.id);

        expect(database.listProjects().map((project) => project.id)).toEqual(projectOrder);
        expect(database.listSessions(firstProject.id).map((session) => session.id)).toEqual(
            sessionOrder,
        );
        expect(database.getAppState('lastSelectedProjectId')).toBe(firstProject.id);
        expect(database.getAppState('lastSelectedSessionId')).toBe(firstSession.session.id);
        database.close();
    });

    it('persists bounded Project moves and rejects stale or malformed targets', async () => {
        const directory = await temporaryDirectory('caxri-db-project-reorder-');
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        const first = database.createProject(join(directory, 'first'));
        const second = database.createProject(join(directory, 'second'));
        const third = database.createProject(join(directory, 'third'));

        expect(database.reorderProject(third.id, 0).map(({ id }) => id)).toEqual([
            third.id,
            first.id,
            second.id,
        ]);
        for (const [projectId, targetIndex] of [
            ['unknown-project', 0],
            [first.id, -1],
            [first.id, 3],
        ] as const) {
            expect(() => database.reorderProject(projectId, targetIndex)).toThrow(
                /current Project and valid position/,
            );
            expect(database.listProjects().map(({ id }) => id)).toEqual([
                third.id,
                first.id,
                second.id,
            ]);
        }
        database.close();

        const reopened = new CaxriDatabase(databasePath);
        expect(reopened.listProjects().map(({ id }) => id)).toEqual([
            third.id,
            first.id,
            second.id,
        ]);
        reopened.close();
    });

    it('never removes the Project directory or user files when deleting metadata', async () => {
        const directory = await temporaryDirectory('caxri-db-project-delete-');
        const root = join(directory, 'project');
        await writeFile(root, 'user-owned', 'utf8');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(root);
        database.createSession(project.id, 'shell');

        database.deleteProject(project.id);

        expect(await readFile(root, 'utf8')).toBe('user-owned');
        expect(database.listProjects()).toEqual([]);
        expect(database.listSessions()).toEqual([]);
        database.close();
    });

    it('falls back to another Project and its most recent Session when the selected Project is deleted', async () => {
        const directory = await temporaryDirectory('caxri-db-project-fallback-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const first = database.createProject(join(directory, 'first'));
        await mkdir(first.rootPath);
        const firstSession = database.createSession(first.id, 'shell');
        const second = database.createProject(join(directory, 'second'));
        await mkdir(second.rootPath);
        database.createSession(second.id, 'shell');
        expect(database.getAppState('lastSelectedProjectId')).toBe(second.id);

        database.deleteProject(second.id);

        expect(database.getAppState('lastSelectedProjectId')).toBe(first.id);
        expect(database.getAppState('lastSelectedSessionId')).toBe(firstSession.session.id);
        database.close();
    });

    it('falls back to another Session in the same Project when the selected Session is deleted', async () => {
        const directory = await temporaryDirectory('caxri-db-session-fallback-');
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(root);
        const first = database.createSession(project.id, 'shell');
        const second = database.createSession(project.id, 'codex');
        expect(database.getAppState('lastSelectedSessionId')).toBe(second.session.id);

        database.deleteSession(second.session.id);

        expect(database.getAppState('lastSelectedSessionId')).toBe(first.session.id);
        expect(database.getAppState('lastSelectedProjectId')).toBe(project.id);
        database.close();
    });

    it('archives Session metadata without deleting its Terminal and restores it later', async () => {
        const directory = await temporaryDirectory('caxri-db-session-archive-');
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(root);
        const first = database.createSession(project.id, 'shell');
        const second = database.createSession(project.id, 'codex');
        const archivedAt = Date.now();

        expect(database.archiveSession(second.session.id, archivedAt)).toMatchObject({
            archivedAt,
            id: second.session.id,
        });
        expect(database.getTerminal(second.terminal!.id)).toMatchObject({
            id: second.terminal!.id,
            sessionId: second.session.id,
        });
        expect(database.getAppState('lastSelectedSessionId')).toBe(first.session.id);
        expect(() => database.selectSession(second.session.id)).toThrow(/restore/i);

        expect(database.unarchiveSession(second.session.id).archivedAt).toBeUndefined();
        database.selectSession(second.session.id);
        expect(database.getAppState('lastSelectedSessionId')).toBe(second.session.id);
        database.close();
    });

    it('synchronizes default Agent metadata into the Session and Terminal records', async () => {
        const directory = await temporaryDirectory('caxri-db-agent-metadata-');
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(root).id, 'codex');

        expect(
            database.updateAgentMetadata(created.terminal!.id, {
                provider: 'codex',
                available: true,
                observedAt: Date.now(),
                sessionId: 'agent-session-1',
                status: 'running',
                title: 'Implement Agent metadata',
            }),
        ).toBe(true);
        expect(database.getSession(created.session.id)).toMatchObject({
            displayTitle: 'Implement Agent metadata',
            lastActivityState: 'running',
        });
        expect(database.getTerminal(created.terminal!.id)).toMatchObject({
            agentSessionId: 'agent-session-1',
        });

        database.updateTerminalState(created.terminal!.id, 'stopped');
        expect(database.getSession(created.session.id)?.lastActivityState).toBe('completed');

        const restartedAt = Date.now() + 1;
        database.resetAgentMetadataForStart(created.terminal!.id, restartedAt);
        expect(database.getTerminal(created.terminal!.id)).toMatchObject({
            agentSessionId: undefined,
            updatedAt: restartedAt,
        });
        expect(database.getSession(created.session.id)).toMatchObject({
            displayTitle: 'Implement Agent metadata',
            lastActivityState: 'running',
        });
        database.close();
    });

    it('persists reliable primary-Agent attention and acknowledges only the current epoch', async () => {
        const directory = await temporaryDirectory('caxri-db-session-attention-');
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        const created = database.createSession(database.createProject(directory).id, 'claude');

        expect(database.getSession(created.session.id)).toMatchObject({
            attentionEpoch: 0,
            readAttentionEpoch: 0,
            hasUnread: false,
        });
        database.updateAgentMetadata(created.terminal!.id, {
            provider: 'claude',
            available: true,
            observedAt: Date.now(),
            status: 'running',
        });
        database.updateAgentMetadata(created.terminal!.id, {
            provider: 'claude',
            attentionKind: 'waiting',
            available: true,
            observedAt: Date.now(),
            status: 'waiting',
            title: 'Needs input',
        });
        expect(database.getSession(created.session.id)).toMatchObject({
            attentionEpoch: 1,
            readAttentionEpoch: 0,
            lastAttentionKind: 'waiting',
            hasUnread: true,
        });

        database.updateAgentMetadata(created.terminal!.id, {
            provider: 'claude',
            attentionKind: 'waiting',
            available: true,
            observedAt: Date.now(),
            status: 'waiting',
            title: 'Still needs input',
        });
        expect(database.getSession(created.session.id)?.attentionEpoch).toBe(1);
        expect(database.markSessionAttentionRead(created.session.id, 1)).toMatchObject({
            acknowledged: true,
            session: { hasUnread: false, readAttentionEpoch: 1 },
        });

        database.updateAgentMetadata(created.terminal!.id, {
            provider: 'claude',
            available: true,
            observedAt: Date.now(),
            status: 'running',
        });
        database.updateAgentMetadata(created.terminal!.id, {
            provider: 'claude',
            attentionKind: 'completed',
            available: true,
            observedAt: Date.now(),
            status: 'completed',
        });
        expect(database.markSessionAttentionRead(created.session.id, 1)).toMatchObject({
            acknowledged: false,
            session: { attentionEpoch: 2, hasUnread: true, readAttentionEpoch: 1 },
        });
        expect(database.markSessionAttentionRead(created.session.id, 2)).toMatchObject({
            acknowledged: true,
            session: { attentionEpoch: 2, hasUnread: false, readAttentionEpoch: 2 },
        });

        database.updateTerminalState(created.terminal!.id, 'running');
        database.markShutdown('orderly');
        expect(database.getSession(created.session.id)).toMatchObject({
            attentionEpoch: 2,
            hasUnread: false,
            readAttentionEpoch: 2,
        });

        database.archiveSession(created.session.id);
        database.close();
        const reopened = new CaxriDatabase(databasePath);
        expect(reopened.unarchiveSession(created.session.id)).toMatchObject({
            attentionEpoch: 2,
            readAttentionEpoch: 2,
            lastAttentionKind: 'completed',
            hasUnread: false,
        });
        reopened.close();
    });

    it('promotes the first Agent Terminal in a Shell Session as its title source', async () => {
        const directory = await temporaryDirectory('caxri-db-primary-agent-');
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(root).id, 'shell');
        const codex = database.createTerminal(created.session.id, 'codex');
        const claude = database.createTerminal(created.session.id, 'claude');

        expect(database.getSession(created.session.id)).toMatchObject({
            displayTitle: 'Untitled',
            primaryAgentTerminalId: codex.id,
        });
        database.updateAgentMetadata(codex.id, {
            provider: 'codex',
            available: true,
            observedAt: Date.now(),
            sessionId: 'codex-session-1',
            status: 'running',
            title: 'Run the development server',
        });
        expect(database.getSession(created.session.id)?.displayTitle).toBe(
            'Run the development server',
        );

        database.updateAgentMetadata(claude.id, {
            provider: 'claude',
            available: true,
            observedAt: Date.now(),
            sessionId: 'claude-session-1',
            status: 'running',
            title: 'Do not replace the first Agent title',
        });
        expect(database.getSession(created.session.id)?.displayTitle).toBe(
            'Run the development server',
        );
        database.close();
    });

    it('keeps Untitled while promoting an Agent Terminal before metadata arrives', async () => {
        const directory = await temporaryDirectory('caxri-db-primary-agent-succession-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const claude = database.createTerminal(created.session.id, 'claude');

        database.closeTerminal(created.terminal!.id);

        expect(database.getSession(created.session.id)).toMatchObject({
            displayTitle: 'Untitled',
            primaryAgentTerminalId: claude.id,
        });
        database.close();
    });

    it('marks Terminals that claimed to be running as interrupted after Runtime reopen', async () => {
        const directory = await temporaryDirectory('caxri-db-recovery-');
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        const created = database.createSession(database.createProject(directory).id, 'shell');
        database.updateTerminalState(created.terminal!.id, 'running');
        database.close();

        const recovered = new CaxriDatabase(databasePath);
        expect(recovered.getTerminal(created.terminal!.id)?.lastProcessState).toBe('interrupted');
        recovered.close();
    });

    it('clears the Session default Terminal reference when that Terminal closes', async () => {
        const directory = await temporaryDirectory('caxri-db-close-terminal-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');

        database.closeTerminal(created.terminal!.id);

        expect(database.getSession(created.session.id)?.primaryAgentTerminalId).toBeUndefined();
        database.close();
    });

    it('collapses only the empty Terminal group when its final Terminal closes', async () => {
        const directory = await temporaryDirectory('caxri-db-close-terminal-group-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const second = database.createTerminal(created.session.id, 'shell');
        const state = database.getSessionState(created.session.id);
        database.updateSessionState({
            ...state,
            layout: splitTerminal(state.layout, second.id, state.layout.activeGroupId!, 'vertical'),
        });

        database.closeTerminal(second.id);

        expect(listLayoutTerminalIds(database.getSessionState(created.session.id).layout)).toEqual([
            created.terminal!.id,
        ]);
        database.close();
    });

    it('never reuses a Terminal order_index after closing a middle Terminal and creating a new one', async () => {
        const directory = await temporaryDirectory('caxri-db-order-index-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const second = database.createTerminal(created.session.id, 'shell');
        const third = database.createTerminal(created.session.id, 'shell');
        expect([created.terminal!.orderIndex, second.orderIndex, third.orderIndex]).toEqual([
            0, 1, 2,
        ]);

        database.closeTerminal(second.id);
        const fourth = database.createTerminal(created.session.id, 'shell');

        expect(fourth.orderIndex).toBe(3);
        const remaining = database.listTerminals(created.session.id);
        const indexes = remaining.map((terminal) => terminal.orderIndex);
        expect(indexes).toEqual(indexes.toSorted((a, b) => a - b));
        expect(new Set(indexes).size).toBe(indexes.length);
        database.close();
    });

    it('moves a Terminal into a brand-new selected Session under the same Project', async () => {
        const directory = await temporaryDirectory('caxri-db-move-terminal-');
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(root);
        const created = database.createSession(project.id, 'codex');
        const shell = database.createTerminal(created.session.id, 'shell');
        const preMoveState = database.getSessionState(created.session.id);
        database.updateSessionState({
            ...preMoveState,
            layout: splitTerminal(
                preMoveState.layout,
                shell.id,
                preMoveState.layout.activeGroupId!,
                'vertical',
            ),
        });
        expect(created.session.primaryAgentTerminalId).toBe(created.terminal!.id);

        const moved = database.moveTerminalToNewSession(created.terminal!.id);

        expect(moved.terminal).toMatchObject({
            id: created.terminal!.id,
            sessionId: moved.session.id,
        });
        expect(moved.session).toMatchObject({
            projectId: project.id,
            displayTitle: 'Untitled',
            primaryAgentTerminalId: created.terminal!.id,
        });
        expect(database.getAppState('lastSelectedSessionId')).toBe(moved.session.id);
        expect(database.getAppState('lastSelectedProjectId')).toBe(project.id);

        expect(listLayoutTerminalIds(database.getSessionState(moved.session.id).layout)).toEqual([
            created.terminal!.id,
        ]);
        expect(listLayoutTerminalIds(database.getSessionState(created.session.id).layout)).toEqual([
            shell.id,
        ]);

        expect(database.getSession(created.session.id)).toMatchObject({
            primaryAgentTerminalId: undefined,
            lastActivityState: 'idle',
        });
        expect(database.getTerminal(shell.id)).toMatchObject({ sessionId: created.session.id });
        database.close();
    });

    it('leaves the source Session with an empty layout and no primary Agent when its only Terminal moves', async () => {
        const directory = await temporaryDirectory('caxri-db-move-only-terminal-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(directory);
        const created = database.createSession(project.id, 'claude');

        const moved = database.moveTerminalToNewSession(created.terminal!.id);

        expect(moved.session).toMatchObject({
            projectId: project.id,
            primaryAgentTerminalId: created.terminal!.id,
        });
        expect(database.getSession(created.session.id)).toMatchObject({
            primaryAgentTerminalId: undefined,
        });
        expect(database.getSessionState(created.session.id)).toMatchObject({ layout: {} });
        expect(listLayoutTerminalIds(database.getSessionState(moved.session.id).layout)).toEqual([
            created.terminal!.id,
        ]);
        database.close();
    });

    it('rejects moving an unknown Terminal', async () => {
        const directory = await temporaryDirectory('caxri-db-move-unknown-terminal-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        expect(() => database.moveTerminalToNewSession('missing-terminal')).toThrow(/not found/i);
        database.close();
    });

    it('rejects databases created by a newer schema version', async () => {
        const directory = await temporaryDirectory('caxri-db-future-schema-');
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        database.close();
        const futureDatabase = new Database(databasePath);
        futureDatabase.pragma('user_version = 99');
        futureDatabase.close();

        expect(() => new CaxriDatabase(databasePath)).toThrow(/newer schema version/i);
    });

    it('limits durable Terminals in one Session', async () => {
        const directory = await temporaryDirectory('caxri-db-terminal-capacity-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        for (let index = 1; index < 16; index += 1) {
            database.createTerminal(created.session.id, 'shell');
        }

        expect(() => database.createTerminal(created.session.id, 'shell')).toThrow(
            'at most 16 Terminals',
        );
        database.close();
    });
});

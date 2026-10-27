import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PaneLayout } from '@caxri/protocol';
import {
    findResourceTabs,
    listPaneTerminalIds,
    openResource,
    splitTabIntoPane,
} from '@caxri/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../repository';
import { activeIn, inMain } from './open-sessions.fixture';

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
 * Splits a Terminal that already sits in `layout` (alongside another tab) off into its own pane, mirroring what the
 * Renderer does when dropping a tab on a pane edge.
 */
function splitTerminalIntoOwnPane(layout: PaneLayout, terminalId: string): PaneLayout {
    const occurrence = findResourceTabs(layout, { kind: 'terminal', terminalId }).at(0)!;
    return splitTabIntoPane(layout, occurrence.tab.id, occurrence.pane.id, 'down');
}

/**
 * Facade-level coverage for `CaxriDatabase`: proves that `../index` (pure SQL) and `../../session-policy` (pure
 * decisions) are wired together correctly inside one transaction per operation. Pure-SQL/schema behavior lives in
 * `./database.integration.test.ts`; pure-decision behavior lives in `./session-policy.test.ts`.
 */
describe('CaxriDatabase', () => {
    it.each([
        ['shell', 'Shell'],
        ['claude', 'Claude'],
        ['codex', 'Codex'],
    ] as const)(
        'starts a new %s Session as Untitled with a provider-specific Terminal title',
        async (kind, terminalTitle) => {
            const directory = await temporaryDirectory(`caxri-db-untitled-${kind}-`);
            const database = new CaxriDatabase(join(directory, 'state.db'));
            const created = database.createSession(database.createProject(directory).id, kind);

            expect(created.session).toMatchObject({
                title: 'Untitled',
                titleMode: 'automatic',
            });
            expect(created.terminal!.title).toBe(terminalTitle);
            database.close();
        },
    );

    it('creates a Terminal-less Session with an empty pane layout when kind is null', async () => {
        const directory = await temporaryDirectory('caxri-db-no-terminal-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, null);

        expect(created.terminal).toBeNull();
        expect(created.session).toMatchObject({
            title: 'Untitled',
            primaryAgentTerminalId: undefined,
        });
        expect(
            listPaneTerminalIds(database.getSessionState(created.session.id).paneLayout),
        ).toEqual([]);
        database.close();
    });

    it('creates a remote Session without changing the desktop selection', async () => {
        const directory = await temporaryDirectory('caxri-db-remote-session-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const selectedProject = database.createProject(join(directory, 'selected'));
        const remoteProject = database.createProject(join(directory, 'remote'));
        const selected = database.createSession(selectedProject.id, 'shell', undefined, inMain);

        const remote = database.createSession(remoteProject.id, 'codex', undefined, {
            selection: 'preserve',
        });

        expect(remote.session.projectId).toBe(remoteProject.id);
        expect(remote.terminal?.kind).toBe('codex');
        expect(activeIn(database)).toBe(selected.session.id);
        expect(database.getAppState('lastSelectedProjectId')).toBe(selectedProject.id);
        database.close();
    });

    it('reuses already loaded Terminal records when listing all Session states', async () => {
        const directory = await temporaryDirectory('caxri-db-session-state-ownership-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(directory);
        database.createSession(project.id, 'shell', undefined, inMain);
        database.createSession(project.id, 'shell', undefined, inMain);
        database.createSession(project.id, null, undefined, inMain);
        const terminalRecords = database.listTerminals();
        const prepare = vi.spyOn(database.database, 'prepare');

        expect(database.listSessionStates(terminalRecords)).toHaveLength(3);
        expect(
            prepare.mock.calls.filter(([statement]) => statement.includes('from "terminals"')),
        ).toHaveLength(0);
        database.close();
    });

    it('persists a PTY display title without replacing the stable Terminal title', async () => {
        const directory = await temporaryDirectory('caxri-db-pty-title-');
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        const created = database.createSession(database.createProject(directory).id, 'shell');

        expect(created.terminal).toMatchObject({ title: 'Shell', ptyTitle: undefined });
        expect(database.setTerminalPtyTitle(created.terminal!.id, 'zsh caxri')).toBe(true);
        expect(database.setTerminalPtyTitle(created.terminal!.id, 'zsh caxri')).toBe(false);
        expect(database.getTerminal(created.terminal!.id)).toMatchObject({
            title: 'Shell',
            ptyTitle: 'zsh caxri',
        });
        database.close();

        const reopened = new CaxriDatabase(databasePath);
        expect(reopened.getTerminal(created.terminal!.id)).toMatchObject({
            title: 'Shell',
            ptyTitle: 'zsh caxri',
        });
        reopened.close();
    });

    it('falls back to each new stable title after promotion and provider switch', async () => {
        const directory = await temporaryDirectory('caxri-db-pty-title-transition-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const terminalId = created.terminal!.id;

        database.setTerminalPtyTitle(terminalId, 'zsh old-project');
        expect(database.promoteShellToAgent(terminalId, 'codex')).toBe(true);
        expect(database.getTerminal(terminalId)).toMatchObject({
            kind: 'codex',
            ptyTitle: undefined,
            title: 'Codex',
        });

        database.setTerminalPtyTitle(terminalId, 'codex reviewing');
        expect(database.confirmForegroundAgentProvider(terminalId, 'claude')).toBe(true);
        expect(database.getTerminal(terminalId)).toMatchObject({
            kind: 'claude',
            ptyTitle: undefined,
            title: 'Claude',
        });
        database.close();
    });

    it('groups Sessions with the same root under one Project', async () => {
        const directory = await temporaryDirectory('caxri-db-project-grouping-');
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));

        const project = database.createProject(root);
        const first = database.createSession(project.id, 'shell', undefined, inMain);
        const second = database.createSession(project.id, 'codex', undefined, inMain);

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

    it('keeps Project and Session ordering stable when a Session is selected', async () => {
        const directory = await temporaryDirectory('caxri-db-stable-selection-order-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const firstProject = database.createProject(join(directory, 'first'));
        const firstSession = database.createSession(firstProject.id, 'shell', undefined, inMain);
        const secondSession = database.createSession(firstProject.id, 'codex', undefined, inMain);
        const secondProject = database.createProject(join(directory, 'second'));
        database.createSession(secondProject.id, 'shell', undefined, inMain);

        database.database
            .prepare('UPDATE projects SET created_at = ?, last_visited_at = ? WHERE id = ?')
            .run(1, 1, firstProject.id);
        database.database
            .prepare('UPDATE projects SET created_at = ?, last_visited_at = ? WHERE id = ?')
            .run(2, 2, secondProject.id);
        database.database
            .prepare('UPDATE sessions SET created_at = ?, last_visited_at = ? WHERE id = ?')
            .run(1, 1, firstSession.session.id);
        database.database
            .prepare('UPDATE sessions SET created_at = ?, last_visited_at = ? WHERE id = ?')
            .run(2, 2, secondSession.session.id);

        const projectOrder = database.listProjects().map((project) => project.id);
        const sessionOrder = database.listSessions(firstProject.id).map((session) => session.id);

        database.selectSession(firstSession.session.id, 'main');

        expect(database.listProjects().map((project) => project.id)).toEqual(projectOrder);
        expect(database.listSessions(firstProject.id).map((session) => session.id)).toEqual(
            sessionOrder,
        );
        expect(database.getAppState('lastSelectedProjectId')).toBe(firstProject.id);
        expect(activeIn(database)).toBe(firstSession.session.id);
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

    it('never removes the Project folder or user files when deleting metadata', async () => {
        const directory = await temporaryDirectory('caxri-db-project-delete-');
        const root = join(directory, 'project');
        await writeFile(root, 'user-owned', 'utf8');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(root);
        database.createSession(project.id, 'shell', undefined, inMain);

        database.deleteProject(project.id);

        expect(await readFile(root, 'utf8')).toBe('user-owned');
        expect(database.listProjects()).toEqual([]);
        expect(database.listSessions()).toEqual([]);
        database.close();
    });

    it('deletes the worktree Projects registered on a deleted Project behalf, and nothing else', async () => {
        const directory = await temporaryDirectory('caxri-db-owned-project-delete-');
        const ownerRoot = join(directory, 'owner');
        const worktreeRoot = join(directory, 'worktree');
        const otherRoot = join(directory, 'other');
        await Promise.all([mkdir(ownerRoot), mkdir(worktreeRoot), mkdir(otherRoot)]);
        await writeFile(join(worktreeRoot, 'worktree-only.txt'), 'user-owned', 'utf8');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const owner = database.createProject(ownerRoot);
        const worktree = database.createProject(worktreeRoot, owner.id);
        const other = database.createProject(otherRoot);
        const ownerSession = database.createSession(owner.id, 'shell', undefined, inMain);
        const otherSession = database.createSession(other.id, 'shell', undefined, inMain);
        database.selectWorkbenchProject(ownerSession.session.id, worktree.id);

        database.deleteProject(owner.id);

        expect(database.listProjects().map(({ id }) => id)).toEqual([other.id]);
        expect(database.listSessions().map(({ id }) => id)).toEqual([otherSession.session.id]);
        expect(database.getTerminal(ownerSession.terminal!.id)).toBeUndefined();
        expect(database.getTerminal(otherSession.terminal!.id)).toBeDefined();
        // Deletion is metadata only; the worktree directory and its files are the user's.
        expect(await readFile(join(worktreeRoot, 'worktree-only.txt'), 'utf8')).toBe('user-owned');
        database.close();
    });

    it('never falls back to a hidden worktree Project when the selected Project is deleted', async () => {
        const directory = await temporaryDirectory('caxri-db-owned-project-fallback-');
        const keeperRoot = join(directory, 'keeper');
        const worktreeRoot = join(directory, 'worktree');
        const selectedRoot = join(directory, 'selected');
        await Promise.all([mkdir(keeperRoot), mkdir(worktreeRoot), mkdir(selectedRoot)]);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const keeper = database.createProject(keeperRoot);
        const worktree = database.createProject(worktreeRoot, keeper.id);
        const selected = database.createProject(selectedRoot);
        const keeperSession = database.createSession(keeper.id, 'shell', undefined, inMain);
        database.createSession(selected.id, 'shell', undefined, inMain);
        /**
         * `order_index` is data, not an invariant the fallback may lean on: an owned row can sort first in a database
         * written by an earlier build. Reproduce that so the fallback is proven to skip hidden rows by ownership.
         */
        const setOrder = database.database.prepare(
            'UPDATE projects SET order_index = ? WHERE id = ?',
        );
        setOrder.run(0, worktree.id);
        setOrder.run(1, keeper.id);
        expect(database.listProjects().map(({ id }) => id)).toEqual([
            worktree.id,
            keeper.id,
            selected.id,
        ]);

        database.deleteProject(selected.id);

        expect(database.getAppState('lastSelectedProjectId')).toBe(keeper.id);
        expect(activeIn(database)).toBe(keeperSession.session.id);
        database.close();
    });

    it('refuses a Session inside an auto-registered worktree Project', async () => {
        const directory = await temporaryDirectory('caxri-db-owned-project-session-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const owner = database.createProject(join(directory, 'owner'));
        const worktree = database.createProject(join(directory, 'worktree'), owner.id);

        // The PrimarySidebar hides the worktree row, so a Session there would have no row to live under.
        expect(() => database.createSession(worktree.id, 'shell')).toThrow(/auto-registered/);
        expect(database.listSessions()).toEqual([]);

        /**
         * The negative control for that refusal. `owner` is top-level and, at this point, has no Session at all: the
         * exact shape a guard that keyed on "empty Project" instead of "owned Project" would reject, turning an added
         * Project into one the user can never start working in.
         */
        const created = database.createSession(owner.id, 'shell', undefined, inMain);
        expect(created.session.projectId).toBe(owner.id);
        database.close();
    });

    it('attaches a worktree registered on behalf of an owned Project to the top-level owner', async () => {
        const directory = await temporaryDirectory('caxri-db-owned-project-chain-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const owner = database.createProject(join(directory, 'owner'));
        const worktree = database.createProject(join(directory, 'worktree'), owner.id);

        // A one-level chain is what the single-level delete cascade relies on.
        const sibling = database.createProject(join(directory, 'sibling'), worktree.id);
        expect(sibling.ownerProjectId).toBe(owner.id);
        expect(() => database.createProject(join(directory, 'orphan'), 'missing')).toThrow(
            /Owning Project not found/,
        );

        database.deleteProject(owner.id);
        expect(database.listProjects()).toEqual([]);
        database.close();
    });

    it('reorders only the Projects the PrimarySidebar shows, keeping hidden worktrees last', async () => {
        const directory = await temporaryDirectory('caxri-db-owned-project-reorder-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const first = database.createProject(join(directory, 'first'));
        const worktree = database.createProject(join(directory, 'worktree'), first.id);
        const second = database.createProject(join(directory, 'second'));

        // Position 1 is the second visible slot; the hidden row between them must not absorb the move.
        expect(database.reorderProject(first.id, 1).map(({ id }) => id)).toEqual([
            second.id,
            first.id,
            worktree.id,
        ]);
        expect(() => database.reorderProject(worktree.id, 0)).toThrow(
            /current Project and valid position/,
        );
        expect(() => database.reorderProject(first.id, 2)).toThrow(
            /current Project and valid position/,
        );
        database.close();
    });

    it('falls back to another Project and its most recent Session when the selected Project is deleted', async () => {
        const directory = await temporaryDirectory('caxri-db-project-fallback-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const first = database.createProject(join(directory, 'first'));
        await mkdir(first.rootPath);
        const firstSession = database.createSession(first.id, 'shell', undefined, inMain);
        const second = database.createProject(join(directory, 'second'));
        await mkdir(second.rootPath);
        database.createSession(second.id, 'shell', undefined, inMain);
        expect(database.getAppState('lastSelectedProjectId')).toBe(second.id);

        database.deleteProject(second.id);

        expect(database.getAppState('lastSelectedProjectId')).toBe(first.id);
        expect(activeIn(database)).toBe(firstSession.session.id);
        database.close();
    });

    it('falls back to another Session in the same Project when the selected Session is deleted', async () => {
        const directory = await temporaryDirectory('caxri-db-session-fallback-');
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(root);
        const first = database.createSession(project.id, 'shell', undefined, inMain);
        const second = database.createSession(project.id, 'codex', undefined, inMain);
        expect(activeIn(database)).toBe(second.session.id);

        database.deleteSession(second.session.id);

        expect(activeIn(database)).toBe(first.session.id);
        expect(database.getAppState('lastSelectedProjectId')).toBe(project.id);
        database.close();
    });

    it('archives Session metadata without deleting its Terminal and restores it later', async () => {
        const directory = await temporaryDirectory('caxri-db-session-archive-');
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(root);
        const first = database.createSession(project.id, 'shell', undefined, inMain);
        const second = database.createSession(project.id, 'codex', undefined, inMain);
        const archivedAt = Date.now();

        expect(database.archiveSession(second.session.id, archivedAt)).toMatchObject({
            archivedAt,
            id: second.session.id,
        });
        expect(database.getTerminal(second.terminal!.id)).toMatchObject({
            id: second.terminal!.id,
            sessionId: second.session.id,
        });
        expect(activeIn(database)).toBe(first.session.id);
        expect(() => database.selectSession(second.session.id, 'main')).toThrow(/restore/i);

        expect(database.unarchiveSessions([second.session.id])[0].archivedAt).toBeUndefined();
        database.selectSession(second.session.id, 'main');
        expect(activeIn(database)).toBe(second.session.id);
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
        const opened = openResource(state.paneLayout, { kind: 'terminal', terminalId: second.id });
        database.updateSessionState({
            ...state,
            paneLayout: splitTerminalIntoOwnPane(opened, second.id),
        });

        database.closeTerminal(second.id);

        expect(
            listPaneTerminalIds(database.getSessionState(created.session.id).paneLayout),
        ).toEqual([created.terminal!.id]);
        database.close();
    });

    it('refuses to let a stale layout write resurrect a closed Terminal tab', async () => {
        const directory = await temporaryDirectory('caxri-db-stale-layout-write-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const second = database.createTerminal(created.session.id, 'shell');
        const staleState = database.getSessionState(created.session.id);
        expect(listPaneTerminalIds(staleState.paneLayout)).toContain(second.id);

        // The Renderer closes the Terminal while it is still assembling the layout write above.
        database.closeTerminal(second.id);
        // Closing advanced the stored revision, so the write is rejected outright rather than
        // reconciled: the caller re-derives from the current state and keeps its own newer intent.
        expect(() => database.updateSessionState(staleState)).toThrow(/stale revision/i);

        expect(
            listPaneTerminalIds(database.getSessionState(created.session.id).paneLayout),
        ).toEqual([created.terminal!.id]);
        database.close();
    });

    it('refuses to let a stale layout write hide a newly created Terminal tab', async () => {
        const directory = await temporaryDirectory('caxri-db-stale-layout-create-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const staleState = database.getSessionState(created.session.id);

        const second = database.createTerminal(created.session.id, 'shell');
        expect(() => database.updateSessionState(staleState)).toThrow(/stale revision/i);

        expect(
            listPaneTerminalIds(database.getSessionState(created.session.id).paneLayout),
        ).toEqual([created.terminal!.id, second.id]);
        database.close();
    });

    /**
     * A write nobody can see is the hardest defect to find. A Terminal regaining focus rebuilt an identical pane layout
     * and wrote it back, and because nothing recorded that the write changed nothing, the resulting "Unable to activate
     * Terminal" notification reached unrelated E2E specs for weeks before anyone could name its source
     * (github.com/tjx666/caxri/issues/877).
     */
    it('reports a Session state write that stored exactly the row it found', async () => {
        const directory = await temporaryDirectory('caxri-db-unchanged-state-write-');
        const unchanged: unknown[] = [];
        const database = new CaxriDatabase(join(directory, 'state.db'), {
            onSessionStateUnchanged: (report) => unchanged.push(report),
        });
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const state = database.getSessionState(created.session.id);

        database.updateSessionState(state);
        database.updateSessionState(state);
        database.updateSessionState({
            ...state,
            desiredSecondarySidebarViewContainerId: 'caxri.sourceControl',
        });

        expect(unchanged).toEqual([
            {
                sessionId: created.session.id,
                workbenchRootProjectId: state.workbenchRootProjectId,
                unchangedWrites: 1,
                totalWrites: 1,
            },
            {
                sessionId: created.session.id,
                workbenchRootProjectId: state.workbenchRootProjectId,
                unchangedWrites: 2,
                totalWrites: 2,
            },
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
        const created = database.createSession(project.id, 'codex', undefined, inMain);
        const shell = database.createTerminal(created.session.id, 'shell');
        const preMoveState = database.getSessionState(created.session.id);
        const openedShell = openResource(preMoveState.paneLayout, {
            kind: 'terminal',
            terminalId: shell.id,
        });
        database.updateSessionState({
            ...preMoveState,
            paneLayout: splitTerminalIntoOwnPane(openedShell, shell.id),
        });
        expect(created.session.primaryAgentTerminalId).toBe(created.terminal!.id);

        const moved = database.moveTerminalToNewSession(created.terminal!.id, 'main');

        expect(moved.terminal).toMatchObject({
            id: created.terminal!.id,
            sessionId: moved.session.id,
        });
        expect(moved.session).toMatchObject({
            projectId: project.id,
            title: 'Untitled',
            primaryAgentTerminalId: created.terminal!.id,
        });
        expect(activeIn(database)).toBe(moved.session.id);
        expect(database.getAppState('lastSelectedProjectId')).toBe(project.id);

        expect(listPaneTerminalIds(database.getSessionState(moved.session.id).paneLayout)).toEqual([
            created.terminal!.id,
        ]);
        expect(
            listPaneTerminalIds(database.getSessionState(created.session.id).paneLayout),
        ).toEqual([shell.id]);

        expect(database.getSession(created.session.id)).toMatchObject({
            primaryAgentTerminalId: undefined,
            agentActivityState: 'idle',
        });
        expect(database.getTerminal(shell.id)).toMatchObject({ sessionId: created.session.id });
        database.close();
    });

    it('leaves the source Session with an empty pane layout and no primary Agent when its only Terminal moves', async () => {
        const directory = await temporaryDirectory('caxri-db-move-only-terminal-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(directory);
        const created = database.createSession(project.id, 'claude', undefined, inMain);

        const moved = database.moveTerminalToNewSession(created.terminal!.id, 'main');

        expect(moved.session).toMatchObject({
            projectId: project.id,
            primaryAgentTerminalId: created.terminal!.id,
        });
        expect(database.getSession(created.session.id)).toMatchObject({
            primaryAgentTerminalId: undefined,
        });
        expect(
            listPaneTerminalIds(database.getSessionState(created.session.id).paneLayout),
        ).toEqual([]);
        expect(listPaneTerminalIds(database.getSessionState(moved.session.id).paneLayout)).toEqual([
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

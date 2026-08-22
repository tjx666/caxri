import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
    findResourceTabs,
    listPaneTerminalIds,
    openResource,
    splitTabIntoPane,
} from '../../../shared/pane-layout';
import { MAX_TERMINAL_TITLE_LENGTH } from '../../../shared/terminal-title';
import type { PaneLayout } from '../../../shared/types';
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

    it('creates a Terminal-less Session with an empty pane layout when kind is null', async () => {
        const directory = await temporaryDirectory('caxri-db-no-terminal-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, null);

        expect(created.terminal).toBeNull();
        expect(created.session).toMatchObject({
            displayTitle: 'Untitled',
            primaryAgentTerminalId: undefined,
        });
        expect(
            listPaneTerminalIds(database.getSessionState(created.session.id).paneLayout),
        ).toEqual([]);
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
        expect(database.switchAgentProvider(terminalId, 'claude')).toBe(true);
        expect(database.getTerminal(terminalId)).toMatchObject({
            kind: 'claude',
            ptyTitle: undefined,
            title: 'Claude Code',
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
        // The Session title belongs to the primary Agent alone, but every Agent Terminal's own tab names its own
        // conversation — a secondary Agent must not be left reading "Claude".
        expect(database.getTerminal(claude.id)?.title).toBe('Do not replace the first Agent title');
        expect(database.getTerminal(codex.id)?.title).toBe('Run the development server');
        database.close();
    });

    it('lets an Agent conversation title beat OSC 0/2 and clears it for a fresh start', async () => {
        const directory = await temporaryDirectory('caxri-db-agent-title-ownership-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, null);
        const terminal = database.createTerminal(created.session.id, 'shell');

        // A plain Shell is titled by its own OSC 0/2 stream, exactly as before.
        expect(database.setTerminalTitle(terminal.id, '~/project')).toBe(true);
        expect(database.getTerminal(terminal.id)?.title).toBe('~/project');

        database.promoteShellToAgent(terminal.id, 'codex', {
            provider: 'codex',
            available: true,
            observedAt: Date.now(),
            sessionId: 'codex-session-1',
            status: 'running',
            title: 'Ship the release notes',
        });
        expect(database.getTerminal(terminal.id)?.title).toBe('Ship the release notes');

        /**
         * A promoted Shell keeps its `provider` after the Agent CLI exits, so its prompt keeps emitting OSC titles that
         * every later metadata probe would overwrite right back. The Agent owns the row from promotion on, and the
         * rejected write reports `false` so no `state.changed` broadcast goes out either.
         */
        expect(database.setTerminalTitle(terminal.id, '~/project')).toBe(false);
        expect(database.getTerminal(terminal.id)?.title).toBe('Ship the release notes');

        // A restart binds a brand new conversation; inheriting the retired one's name would misname it indefinitely.
        database.resetAgentMetadataForStart(terminal.id);
        expect(database.getTerminal(terminal.id)?.title).toBe('Codex');
        database.close();
    });

    it('caps an Agent conversation title at the length the Host will accept back', async () => {
        const directory = await temporaryDirectory('caxri-db-agent-title-length-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'codex');
        const terminal = created.terminal!;

        database.updateAgentMetadata(terminal.id, {
            provider: 'codex',
            available: true,
            observedAt: Date.now(),
            sessionId: 'codex-session-1',
            status: 'running',
            title: 'x'.repeat(500),
        });

        /**
         * `Terminal.title` is replayed as `agentEndpoint.begin.name` on the next launch, where the Host schema caps it
         * at 200 characters and rejects the whole request otherwise — an over-long conversation name would fail the
         * Agent's next start rather than just look wrong.
         */
        const title = database.getTerminal(terminal.id)?.title ?? '';
        expect(title.length).toBeLessThanOrEqual(MAX_TERMINAL_TITLE_LENGTH);
        expect(title).toBe('x'.repeat(MAX_TERMINAL_TITLE_LENGTH));
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
        database.updateSessionState(staleState);

        expect(
            listPaneTerminalIds(database.getSessionState(created.session.id).paneLayout),
        ).toEqual([created.terminal!.id]);
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
        const openedShell = openResource(preMoveState.paneLayout, {
            kind: 'terminal',
            terminalId: shell.id,
        });
        database.updateSessionState({
            ...preMoveState,
            paneLayout: splitTerminalIntoOwnPane(openedShell, shell.id),
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

        expect(listPaneTerminalIds(database.getSessionState(moved.session.id).paneLayout)).toEqual([
            created.terminal!.id,
        ]);
        expect(
            listPaneTerminalIds(database.getSessionState(created.session.id).paneLayout),
        ).toEqual([shell.id]);

        expect(database.getSession(created.session.id)).toMatchObject({
            primaryAgentTerminalId: undefined,
            lastActivityState: 'idle',
        });
        expect(database.getTerminal(shell.id)).toMatchObject({ sessionId: created.session.id });
        database.close();
    });

    it('leaves the source Session with an empty pane layout and no primary Agent when its only Terminal moves', async () => {
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

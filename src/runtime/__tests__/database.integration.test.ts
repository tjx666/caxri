import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import Database from 'better-sqlite3';

import { listLayoutTerminalIds, splitTerminal } from '../../shared/terminal-layout';
import { CaxriDatabase } from '../database';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('CaxriDatabase', () => {
    it('groups Sessions with the same root under one Project', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-project-grouping-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));

        const project = database.createProject(root);
        const first = database.createSession(project.id, 'shell');
        const second = database.createSession(project.id, 'codex');

        expect(database.createProject(root)).toMatchObject({ id: project.id, rootPath: root });
        expect(database.listProjects()).toEqual([
            expect.objectContaining({ id: project.id, rootPath: root }),
        ]);
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
        expect(
            (database.database.pragma('table_info(sessions)') as Array<{ name: string }>).map(
                (column) => column.name,
            ),
        ).not.toContain('root_path');
        database.close();
    });

    it('deletes Project metadata without touching its local directory', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-project-delete-'));
        temporaryDirectories.push(directory);
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

    it('synchronizes default Agent metadata into the Session and Terminal records', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-db-agent-metadata-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(root).id, 'codex');

        expect(
            database.updateAgentMetadata(created.terminal.id, {
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
        expect(database.getTerminal(created.terminal.id)).toMatchObject({
            agentSessionId: 'agent-session-1',
        });

        database.updateTerminalState(created.terminal.id, 'stopped');
        expect(database.getSession(created.session.id)?.lastActivityState).toBe('completed');

        expect(
            database.updateAgentMetadata(created.terminal.id, {
                provider: 'codex',
                available: true,
                observedAt: Date.now(),
                status: 'unknown',
            }),
        ).toBe(true);
        expect(database.getSession(created.session.id)).toMatchObject({
            displayTitle: 'Implement Agent metadata',
            lastActivityState: 'unknown',
        });
        database.close();
    });

    it('keeps metadata for multiple Agent providers in the same Session', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-db-multi-agent-metadata-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(root).id, 'codex');
        const claude = database.createTerminal(created.session.id, 'claude');

        expect(
            database.updateAgentMetadata(claude.id, {
                provider: 'claude',
                available: true,
                observedAt: Date.now(),
                sessionId: 'claude-session-1',
                status: 'waiting',
                title: 'Review the implementation',
            }),
        ).toBe(true);
        expect(database.getTerminal(claude.id)).toMatchObject({
            agentSessionId: 'claude-session-1',
        });
        expect(database.getSession(created.session.id)).toMatchObject({
            displayTitle: 'Codex',
            lastActivityState: 'idle',
        });
        database.close();
    });

    it('promotes the first Agent Terminal in a Shell Session as its title source', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-db-primary-agent-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(root).id, 'shell');
        const codex = database.createTerminal(created.session.id, 'codex');
        const claude = database.createTerminal(created.session.id, 'claude');

        expect(database.getSession(created.session.id)).toMatchObject({
            displayTitle: 'Codex',
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

    it('allows duplicate roots and deletes metadata without touching user files', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-db-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await writeFile(root, 'user-owned', 'utf8');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(root);
        const first = database.createSession(project.id, 'shell');
        const second = database.createSession(project.id, 'codex');
        expect(database.listSessions()).toHaveLength(2);
        expect(first.session.id).not.toBe(second.session.id);
        database.deleteSession(first.session.id);
        expect(await readFile(root, 'utf8')).toBe('user-owned');
        expect(database.listSessions()).toHaveLength(1);
        database.close();
    });

    it('marks terminals that claimed to be running as dead after Runtime reopen', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-recovery-'));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        const created = database.createSession(database.createProject(directory).id, 'shell');
        database.updateTerminalState(created.terminal.id, 'running');
        database.close();
        const recovered = new CaxriDatabase(databasePath);
        expect(recovered.getTerminal(created.terminal.id)?.lastProcessState).toBe('dead');
        recovered.close();
    });

    it('clears the Session default Terminal reference when that Terminal closes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-close-terminal-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');

        database.closeTerminal(created.terminal.id);

        expect(database.getSession(created.session.id)?.primaryAgentTerminalId).toBeUndefined();
        database.close();
    });

    it('collapses only the empty Terminal group when its final Terminal closes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-close-terminal-group-'));
        temporaryDirectories.push(directory);
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
            created.terminal.id,
        ]);
        database.close();
    });

    it('rejects databases created by a newer schema version', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-future-schema-'));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, 'state.db');
        const futureDatabase = new Database(databasePath);
        futureDatabase.pragma('user_version = 99');
        futureDatabase.close();

        expect(() => new CaxriDatabase(databasePath)).toThrow(/newer schema version/i);
    });

    it('rebuilds pre-release layout metadata without touching Project files', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-layout-schema-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await writeFile(projectRoot, 'user-owned', 'utf8');
        const databasePath = join(directory, 'state.db');
        const previous = new CaxriDatabase(databasePath);
        previous.createSession(previous.createProject(projectRoot).id, 'shell');
        previous.database.pragma('user_version = 2');
        previous.close();

        const rebuilt = new CaxriDatabase(databasePath);

        expect(rebuilt.listProjects()).toEqual([]);
        expect(rebuilt.listSessions()).toEqual([]);
        expect(await readFile(projectRoot, 'utf8')).toBe('user-owned');
        rebuilt.close();
    });

    it('restricts the database and WAL sidecar files to the current user', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-db-permissions-'));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        database.createSession(database.createProject(directory).id, 'shell');

        for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
            expect((await stat(path)).mode & 0o777).toBe(0o600);
        }
        database.close();
    });

    it('limits durable Terminals in one Session', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-terminal-capacity-'));
        temporaryDirectories.push(directory);
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

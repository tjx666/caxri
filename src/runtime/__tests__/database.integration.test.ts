import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function tempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

/**
 * Facade-level coverage for `CaxriDatabase`: proves that `./store` (pure SQL) and
 * `./session-policy` (pure decisions) are wired together correctly inside one transaction per
 * operation. Pure-SQL/schema behavior lives in `../store/__tests__/store.integration.test.ts`;
 * pure-decision behavior lives in `./session-policy.test.ts`.
 */
describe('CaxriDatabase', () => {
    it('groups Sessions with the same root under one Project', async () => {
        const directory = await tempDir('caxri-db-project-grouping-');
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

    it('never removes the Project directory or user files when deleting metadata', async () => {
        const directory = await tempDir('caxri-db-project-delete-');
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
        const directory = await tempDir('caxri-db-project-fallback-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const first = database.createProject(join(directory, 'first'));
        await mkdir(first.rootPath);
        const firstSession = database.createSession(first.id, 'shell');
        const second = database.createProject(join(directory, 'second'));
        await mkdir(second.rootPath);
        database.createSession(second.id, 'shell');
        expect(database.getAppState<string>('lastSelectedProjectId')).toBe(second.id);

        database.deleteProject(second.id);

        expect(database.getAppState<string>('lastSelectedProjectId')).toBe(first.id);
        expect(database.getAppState<string>('lastSelectedSessionId')).toBe(firstSession.session.id);
        database.close();
    });

    it('falls back to another Session in the same Project when the selected Session is deleted', async () => {
        const directory = await tempDir('caxri-db-session-fallback-');
        const root = join(directory, 'project');
        await mkdir(root);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(root);
        const first = database.createSession(project.id, 'shell');
        const second = database.createSession(project.id, 'codex');
        expect(database.getAppState<string>('lastSelectedSessionId')).toBe(second.session.id);

        database.deleteSession(second.session.id);

        expect(database.getAppState<string>('lastSelectedSessionId')).toBe(first.session.id);
        expect(database.getAppState<string>('lastSelectedProjectId')).toBe(project.id);
        database.close();
    });

    it('synchronizes default Agent metadata into the Session and Terminal records', async () => {
        const directory = await tempDir('caxri-db-agent-metadata-');
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
        database.close();
    });

    it('promotes the first Agent Terminal in a Shell Session as its title source', async () => {
        const directory = await tempDir('caxri-db-primary-agent-');
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

    it('marks Terminals that claimed to be running as dead after Runtime reopen', async () => {
        const directory = await tempDir('caxri-db-recovery-');
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
        const directory = await tempDir('caxri-db-close-terminal-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');

        database.closeTerminal(created.terminal.id);

        expect(database.getSession(created.session.id)?.primaryAgentTerminalId).toBeUndefined();
        database.close();
    });

    it('collapses only the empty Terminal group when its final Terminal closes', async () => {
        const directory = await tempDir('caxri-db-close-terminal-group-');
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

    it('never reuses a Terminal order_index after closing a middle Terminal and creating a new one', async () => {
        const directory = await tempDir('caxri-db-order-index-');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(database.createProject(directory).id, 'shell');
        const second = database.createTerminal(created.session.id, 'shell');
        const third = database.createTerminal(created.session.id, 'shell');
        expect([created.terminal.orderIndex, second.orderIndex, third.orderIndex]).toEqual([
            0, 1, 2,
        ]);

        database.closeTerminal(second.id);
        const fourth = database.createTerminal(created.session.id, 'shell');

        expect(fourth.orderIndex).toBe(3);
        const remaining = database.listTerminals(created.session.id);
        const indexes = remaining.map((terminal) => terminal.orderIndex);
        expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
        expect(new Set(indexes).size).toBe(indexes.length);
        database.close();
    });

    it('rejects databases created by a newer schema version', async () => {
        const directory = await tempDir('caxri-db-future-schema-');
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        database.close();
        const futureDatabase = new Database(databasePath);
        futureDatabase.pragma('user_version = 99');
        futureDatabase.close();

        expect(() => new CaxriDatabase(databasePath)).toThrow(/newer schema version/i);
    });

    it('limits durable Terminals in one Session', async () => {
        const directory = await tempDir('caxri-db-terminal-capacity-');
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

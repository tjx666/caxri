import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import Database from 'better-sqlite3';

import { CaxriDatabase } from '../database';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('CaxriDatabase', () => {
    it('allows duplicate roots and deletes metadata without touching user files', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-db-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        await writeFile(root, 'user-owned', 'utf8');
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const first = database.createSession(root, 'shell');
        const second = database.createSession(root, 'codex');
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
        const created = database.createSession(directory, 'shell');
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
        const created = database.createSession(directory, 'shell');

        database.closeTerminal(created.terminal.id);

        expect(database.getSession(created.session.id)?.defaultAgentTerminalId).toBeUndefined();
        database.close();
    });

    it('rejects databases created by a newer schema version', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-future-schema-'));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, 'state.db');
        const futureDatabase = new Database(databasePath);
        futureDatabase.pragma('user_version = 2');
        futureDatabase.close();

        expect(() => new CaxriDatabase(databasePath)).toThrow(/newer schema version/i);
    });

    it('restricts the database and WAL sidecar files to the current user', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-db-permissions-'));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        database.createSession(directory, 'shell');

        for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
            expect((await stat(path)).mode & 0o777).toBe(0o600);
        }
        database.close();
    });

    it('limits durable Terminals in one Session', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-terminal-capacity-'));
        temporaryDirectories.push(directory);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const created = database.createSession(directory, 'shell');
        for (let index = 1; index < 16; index += 1) {
            database.createTerminal(created.session.id, 'shell');
        }

        expect(() => database.createTerminal(created.session.id, 'shell')).toThrow(
            'at most 16 Terminals',
        );
        database.close();
    });
});

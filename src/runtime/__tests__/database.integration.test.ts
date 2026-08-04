import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
});

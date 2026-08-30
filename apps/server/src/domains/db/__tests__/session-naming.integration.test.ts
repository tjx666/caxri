import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../repository';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pending = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pending.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Session naming ownership persistence', () => {
    it('persists manual ownership across metadata resets, reopen, and explicit resume', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-db-session-naming-'));
        temporaryDirectories.push(directory);
        const databasePath = join(directory, 'state.db');
        const database = new CaxriDatabase(databasePath);
        const created = database.createSession(database.createProject(directory).id, 'codex');

        expect(database.sessionNaming.get(created.session.id)).toEqual({ state: 'active' });
        expect(
            database.sessionNaming.recordAutomaticTitle(created.session.id, '🧭 Automatic name'),
        ).toBe(true);
        expect(database.sessionNaming.get(created.session.id)).toEqual({
            lastAutoTitle: '🧭 Automatic name',
            state: 'active',
        });

        expect(database.renameSession(created.session.id, '  Manual name  ')).toMatchObject({
            autoNamingState: 'stopped',
            displayTitle: 'Manual name',
            titleMode: 'manual',
        });
        expect(database.sessionNaming.get(created.session.id)).toEqual({ state: 'stopped' });
        database.resetAgentMetadataForStart(created.terminal!.id);
        expect(database.getSession(created.session.id)).toMatchObject({
            displayTitle: 'Manual name',
            titleMode: 'manual',
        });
        database.close();

        const reopened = new CaxriDatabase(databasePath);
        expect(reopened.getSession(created.session.id)).toMatchObject({
            autoNamingState: 'stopped',
            displayTitle: 'Manual name',
            titleMode: 'manual',
        });
        expect(reopened.sessionNaming.resume(created.session.id, 'Manual name')).toBe(true);
        expect(reopened.getSession(created.session.id)).toMatchObject({
            autoNamingState: 'active',
            displayTitle: 'Manual name',
            titleMode: 'automatic',
        });
        expect(reopened.sessionNaming.get(created.session.id)).toEqual({
            lastAutoTitle: 'Manual name',
            state: 'active',
        });
        reopened.close();
    });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../connection';
import { CaxriDatabase } from '../index';
import { createDatabaseBeforeMigration, seedSessionWithChat } from './pre-migration.fixture';

async function openDatabase(): Promise<{ path: string; database: CaxriDatabase }> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-chat-permission-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.db');
    return { path, database: new CaxriDatabase(path) };
}

describe('Chat permission choices', () => {
    it('adds the columns when upgrading across 0006_chat_permission_modes', async () => {
        let ids = { projectId: '', terminalId: '' };
        const { path } = await createDatabaseBeforeMigration(
            '0006_chat_permission_modes',
            (raw) => {
                ids = seedSessionWithChat(raw, 'codex');
            },
        );

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());
        expect(upgraded.getProject(ids.projectId)).not.toHaveProperty('chatDefaults');
        expect(upgraded.getChatPermission(ids.terminalId)).toEqual({ planMode: false });
        const check = new Database(path, { readonly: true });
        onTestFinished(() => {
            check.close();
        });
        expect(check.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    });

    it('starts a new Chat from its Project default and keeps a later choice', async () => {
        const { path, database } = await openDatabase();
        onTestFinished(() => database.close());
        const project = database.createProject(join(path, '..', 'project'));
        database.setProjectChatDefault(project.id, 'codex', {
            permissionMode: 'readOnly',
            planMode: true,
        });
        // Grok Build has no read-only level and no plan mode.
        expect(() =>
            database.setProjectChatDefault(project.id, 'grok', { permissionMode: 'readOnly' }),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
        expect(() =>
            database.setProjectChatDefault(project.id, 'grok', { planMode: true }),
        ).toThrow(expect.objectContaining({ code: 'VALIDATION' }));
        expect(database.getProject(project.id)?.chatDefaults?.codex).toEqual({
            permissionMode: 'readOnly',
            planMode: true,
        });
        const { session } = database.createSession(project.id, null);

        const codex = database.createTerminal(session.id, 'codex', undefined, 'chat');
        expect(database.getChatPermission(codex.id)).toEqual({
            permissionMode: 'readOnly',
            planMode: true,
        });
        const grok = database.createTerminal(session.id, 'grok', undefined, 'chat');
        expect(database.getChatPermission(grok.id)).toEqual({ planMode: false });

        database.setChatPermission(codex.id, { permissionMode: 'fullAccess', planMode: false });
        database.terminalSurfaces.switch(codex.id, 'pty');
        database.terminalSurfaces.switch(codex.id, 'chat');
        expect(database.getChatPermission(codex.id)).toEqual({
            permissionMode: 'fullAccess',
            planMode: false,
        });

        database.setProjectChatDefault(project.id, 'codex', null);
        expect(database.getProject(project.id)?.chatDefaults?.codex).toBeUndefined();
    });

    it('applies the Project default the first time a Terminal switches to Chat', async () => {
        const { path, database } = await openDatabase();
        onTestFinished(() => database.close());
        const project = database.createProject(join(path, '..', 'project'));
        database.setProjectChatDefault(project.id, 'claude', { permissionMode: 'acceptEdits' });
        const { session } = database.createSession(project.id, null);
        const terminal = database.createTerminal(session.id, 'claude');
        expect(database.getChatPermission(terminal.id)).toEqual({ planMode: false });

        database.terminalSurfaces.switch(terminal.id, 'chat');
        expect(database.getChatPermission(terminal.id)).toEqual({
            permissionMode: 'acceptEdits',
            planMode: false,
        });
    });
});

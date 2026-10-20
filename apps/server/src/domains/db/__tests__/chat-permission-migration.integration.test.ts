import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../connection';
import { CaxriDatabase } from '../index';

async function openDatabase(): Promise<{ path: string; database: CaxriDatabase }> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-chat-permission-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.db');
    return { path, database: new CaxriDatabase(path) };
}

describe('Chat permission choices', () => {
    it('adds the columns when upgrading from the previous schema version', async () => {
        const { path, database } = await openDatabase();
        const project = database.createProject(join(path, '..', 'project'));
        const { session } = database.createSession(project.id, null);
        const chat = database.createTerminal(session.id, 'codex', undefined, 'chat');
        database.close();
        const raw = new Database(path);
        raw.exec(
            'ALTER TABLE projects DROP COLUMN chat_defaults; ALTER TABLE terminals DROP COLUMN chat_permission_mode; ALTER TABLE terminals DROP COLUMN chat_plan_mode',
        );
        // `0007_benchmark_runs`, `0008_session_creator`, and `0009_agent_chat_persistence` came after these columns, so
        // that version predates them too.
        raw.exec('DROP TABLE benchmark_runs');
        raw.exec('ALTER TABLE sessions DROP COLUMN created_by_session_id');
        raw.exec(
            'DROP TABLE agent_chat_answered_notices; DROP TABLE agent_chat_process_groups; ALTER TABLE terminals DROP COLUMN agent_resume_at',
        );
        raw.pragma(`user_version = ${CURRENT_SCHEMA_VERSION - 4}`);
        raw.close();

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());
        expect(upgraded.getProject(project.id)).not.toHaveProperty('chatDefaults');
        expect(upgraded.getChatPermission(chat.id)).toEqual({ planMode: false });
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

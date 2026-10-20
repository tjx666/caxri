import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../connection';
import { AgentChatStateModel, CaxriDatabase } from '../index';

async function openDatabase(): Promise<{ path: string; database: CaxriDatabase }> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-agent-chat-persistence-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.db');
    return { path, database: new CaxriDatabase(path) };
}

describe('Agent Chat persistence tables', () => {
    it('adds the tables and the resume column when upgrading from the previous schema version', async () => {
        const { path, database } = await openDatabase();
        const project = database.createProject(join(path, '..', 'project'));
        const { session } = database.createSession(project.id, null);
        const chat = database.createTerminal(session.id, 'claude', undefined, 'chat');
        database.close();
        const raw = new Database(path);
        raw.exec(
            'DROP TABLE agent_chat_answered_notices; DROP TABLE agent_chat_process_groups; ALTER TABLE terminals DROP COLUMN agent_resume_at',
        );
        raw.pragma(`user_version = ${CURRENT_SCHEMA_VERSION - 1}`);
        raw.close();

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());
        const state = new AgentChatStateModel(upgraded.database);
        expect(state.resumeAt(chat.id)).toBeUndefined();
        state.setResumeAt(chat.id, 'record-1');
        expect(state.resumeAt(chat.id)).toBe('record-1');
        expect(state.answeredNotices.list(chat.id)).toEqual([]);
        expect(state.processGroups.list()).toEqual([]);
        const check = new Database(path, { readonly: true });
        onTestFinished(() => {
            check.close();
        });
        expect(check.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    });

    it('deletes a Chat notices with its Terminal and keeps the resume point private to it', async () => {
        const { path, database } = await openDatabase();
        onTestFinished(() => database.close());
        const project = database.createProject(join(path, '..', 'project'));
        const { session } = database.createSession(project.id, null);
        const chat = database.createTerminal(session.id, 'codex', undefined, 'chat');
        const state = new AgentChatStateModel(database.database);
        state.answeredNotices.save(
            chat.id,
            { id: 'n1', type: 'notice', kind: 'answered', turnId: 't1', message: 'Color: Blue' },
            'u1',
        );
        expect(state.answeredNotices.list(chat.id)).toMatchObject([
            { notice: { id: 'n1', message: 'Color: Blue' }, after: 'u1' },
        ]);
        database.closeTerminal(chat.id);
        expect(state.answeredNotices.list(chat.id)).toEqual([]);
    });
});

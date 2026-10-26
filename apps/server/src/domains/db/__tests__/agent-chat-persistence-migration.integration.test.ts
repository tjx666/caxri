import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../connection';
import { AgentChatStateModel, CaxriDatabase } from '../index';
import { createDatabaseBeforeMigration, seedSessionWithChat } from './pre-migration.fixture';

async function openDatabase(): Promise<{ path: string; database: CaxriDatabase }> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-agent-chat-persistence-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.db');
    return { path, database: new CaxriDatabase(path) };
}

describe('Agent Chat persistence tables', () => {
    it('adds the tables and the resume column when upgrading across 0009_agent_chat_persistence', async () => {
        let chatId = '';
        const { path } = await createDatabaseBeforeMigration(
            '0009_agent_chat_persistence',
            (raw) => {
                chatId = seedSessionWithChat(raw).terminalId;
            },
        );

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());
        const state = new AgentChatStateModel(upgraded.database);
        expect(state.resumeAt(chatId)).toBeUndefined();
        state.setResumeAt(chatId, 'record-1');
        expect(state.resumeAt(chatId)).toBe('record-1');
        expect(state.answeredNotices.list(chatId)).toEqual([]);
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

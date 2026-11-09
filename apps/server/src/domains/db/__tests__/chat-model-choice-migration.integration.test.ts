import { describe, expect, it, onTestFinished } from 'vitest';

import { AgentChatStateModel, CaxriDatabase } from '../index';
import { databaseBeforeMigration } from './session-relation-migration.fixture';

const MIGRATION_TAG = '0018_chat_model_choice';

describe(`${MIGRATION_TAG} migration`, () => {
    it('keeps existing Chats on the global default until the picker switches them', async () => {
        const path = await databaseBeforeMigration(MIGRATION_TAG, (database) => {
            database.exec(`
                INSERT INTO projects (id, root_path, title, created_at, last_visited_at)
                    VALUES ('project-1', '/tmp/caxri-chat-choice-project', 'Project', 1, 1);
                INSERT INTO sessions (id, project_id, created_at, last_visited_at, session_activity_at, session_activity_reason, title)
                    VALUES ('session-1', 'project-1', 1, 1, 1, 'created', 'Session');
                INSERT INTO terminals (id, session_id, kind, cwd, title, order_index, agent_session_id, last_process_state, surface, created_at, updated_at)
                    VALUES ('terminal-1', 'session-1', 'claude', '/tmp', 'Claude', 0, 'session-a', 'stopped', 'chat', 1, 1);
            `);
        });

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());
        const store = new AgentChatStateModel(upgraded.database);

        expect(upgraded.getTerminal('terminal-1')?.agentSessionId).toBe('session-a');
        expect(store.choice('terminal-1')).toEqual({});

        store.setChoice('terminal-1', { model: 'opus', effort: 'max', ultracode: true });
        expect(store.choice('terminal-1')).toEqual({
            model: 'opus',
            effort: 'max',
            ultracode: true,
        });
    });
});

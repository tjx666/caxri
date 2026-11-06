import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../index';
import { databaseBeforeMigration } from './session-relation-migration.fixture';

const MIGRATION_TAG = '0013_session_resolved_attention';

const columns =
    'id, project_id, created_at, last_visited_at, session_activity_at, session_activity_reason, title, agent_activity_state, attention_generation, acknowledged_attention_generation';

describe(`${MIGRATION_TAG} migration`, () => {
    it('keeps only the Sessions the previous Activity view still listed as waiting on the user pending', async () => {
        const now = Date.now();
        const path = await databaseBeforeMigration(MIGRATION_TAG, (database) => {
            database.exec(`
                INSERT INTO projects (id, root_path, title, created_at, last_visited_at)
                    VALUES ('project-1', '/tmp/caxri-resolved-attention-project', 'Project', 1, 1);
                INSERT INTO sessions (${columns}) VALUES
                    ('unread', 'project-1', 1, 1, 1, 'agent_completed', 'Unread', 'completed', 2, 1),
                    ('question', 'project-1', 1, 1, 1, 'agent_waiting', 'Question', 'waiting', 3, 3),
                    ('failed', 'project-1', 1, 1, 1, 'agent_completed', 'Failed', 'failed', 1, 1),
                    ('recent', 'project-1', 1, 1, ${now - 60_000}, 'agent_completed', 'Recent', 'completed', 4, 4),
                    ('old', 'project-1', 1, 1, 1, 'agent_completed', 'Old', 'completed', 5, 5),
                    ('never', 'project-1', 1, 1, 1, 'created', 'Never', 'idle', 0, 0);
            `);
        });

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());

        const pending = Object.fromEntries(
            upgraded.listSessions().map((session) => [session.id, session.hasPendingAttention]),
        );
        expect(pending).toEqual({
            unread: true,
            question: true,
            failed: true,
            recent: true,
            old: false,
            never: false,
        });
        expect(upgraded.getSession('old')).toMatchObject({
            resolvedAttentionGeneration: 5,
            hasUnread: false,
        });
        expect(upgraded.getSession('old')?.attentionResolvedAt).toBeUndefined();
    });
});

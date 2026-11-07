import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../index';
import { databaseBeforeMigration } from './session-relation-migration.fixture';

const MIGRATION_TAG = '0016_delegation_owner_conversation';

describe(`${MIGRATION_TAG} migration`, () => {
    it('keeps earlier history rows readable by their exact principal, with no owner conversation', async () => {
        const path = await databaseBeforeMigration(MIGRATION_TAG, (database) => {
            database.exec(`
                INSERT INTO delegation_history
                    (delegation_id, root_delegation_id, session_id, project_id, owner_terminal_id,
                     owner_principal_hash, provider, outcome, created_at, settled_at)
                    VALUES ('task-1', 'task-1', 'session-1', 'project-1', 'terminal-1', 'hash-1', 'claude',
                            'completed', 1, 2);
            `);
        });

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());

        const rows = (conversationId: string | undefined, principalHash: string) =>
            upgraded.agentDelegations.history
                .page({
                    scope: {
                        kind: 'caller',
                        terminalId: 'terminal-1',
                        principalHash,
                        conversationId,
                        anyPrincipal: false,
                    },
                    limit: 10,
                })
                .map((row) => [row.delegationId, row.ownerConversationId]);
        expect(rows('conversation-1', 'hash-1')).toEqual([['task-1', null]]);
        expect(rows('conversation-1', 'hash-2')).toEqual([]);
    });
});

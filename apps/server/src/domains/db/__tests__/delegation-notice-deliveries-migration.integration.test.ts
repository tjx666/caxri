import type Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../index';
import { MAX_NOTICE_DELIVERIES_PER_TERMINAL } from '../models/delegation-notice-deliveries';
import {
    databaseBeforeMigration,
    seedCreatorLinkedSessions,
} from './session-relation-migration.fixture';

const MIGRATION_TAG = '0012_delegation_notice_deliveries';

const notice = {
    items: [{ delegationId: 'task-1', sessionId: 'session-created', event: 'completed' as const }],
};

function digestOf(index: number): string {
    return String(index).padStart(64, '0');
}

function seed(database: Database.Database): void {
    seedCreatorLinkedSessions(database, 'consult');
    database.exec(`
        INSERT INTO agent_delegations (id, session_id, record_json)
            VALUES ('task-1', 'session-created', '{"receipt":{"status":"completed"}}');
    `);
}

async function upgrade() {
    const path = await databaseBeforeMigration(MIGRATION_TAG, seed);
    const upgraded = new CaxriDatabase(path);
    onTestFinished(() => upgraded.close());
    return upgraded;
}

describe(`${MIGRATION_TAG} migration`, () => {
    it('keeps existing rows and finds a recorded notice by Terminal and digest', async () => {
        const upgraded = await upgrade();
        const { noticeDeliveries } = upgraded.agentDelegations;

        expect(upgraded.database.pragma('foreign_key_check')).toEqual([]);
        noticeDeliveries.record('terminal-1', digestOf(1), notice, 1);

        expect(noticeDeliveries.delivered('terminal-1', digestOf(1))).toEqual(notice);
        expect(noticeDeliveries.delivered('terminal-1', digestOf(2))).toBeUndefined();
        // The same text delivered to another Terminal is not a notice of this one.
        expect(noticeDeliveries.delivered('terminal-2', digestOf(1))).toBeUndefined();
    });

    it('survives pruning the task record and goes with the Terminal', async () => {
        const upgraded = await upgrade();
        const { noticeDeliveries } = upgraded.agentDelegations;
        noticeDeliveries.record('terminal-1', digestOf(1), notice, 1);

        upgraded.database.exec("DELETE FROM agent_delegations WHERE id = 'task-1'");
        expect(noticeDeliveries.delivered('terminal-1', digestOf(1))).toEqual(notice);

        upgraded.database.exec("DELETE FROM terminals WHERE id = 'terminal-1'");
        expect(noticeDeliveries.delivered('terminal-1', digestOf(1))).toBeUndefined();
    });

    it('ignores a Terminal that is already gone and forgets a refused write', async () => {
        const upgraded = await upgrade();
        const { noticeDeliveries } = upgraded.agentDelegations;

        noticeDeliveries.record('missing', digestOf(1), notice, 1);
        expect(noticeDeliveries.delivered('missing', digestOf(1))).toBeUndefined();

        noticeDeliveries.record('terminal-1', digestOf(3), notice, 1);
        noticeDeliveries.remove('terminal-1', digestOf(3));
        expect(noticeDeliveries.delivered('terminal-1', digestOf(3))).toBeUndefined();
    });

    it('keeps only the newest deliveries of a Terminal', async () => {
        const upgraded = await upgrade();
        const { noticeDeliveries } = upgraded.agentDelegations;

        for (let index = 0; index < MAX_NOTICE_DELIVERIES_PER_TERMINAL + 3; index += 1)
            noticeDeliveries.record('terminal-1', digestOf(index), notice, index + 1);

        expect(noticeDeliveries.delivered('terminal-1', digestOf(0))).toBeUndefined();
        expect(
            noticeDeliveries.delivered(
                'terminal-1',
                digestOf(MAX_NOTICE_DELIVERIES_PER_TERMINAL + 2),
            ),
        ).toEqual(notice);
        expect(
            upgraded.database
                .prepare('SELECT count(*) AS n FROM delegation_notice_deliveries')
                .get(),
        ).toEqual({ n: MAX_NOTICE_DELIVERIES_PER_TERMINAL });
    });
});

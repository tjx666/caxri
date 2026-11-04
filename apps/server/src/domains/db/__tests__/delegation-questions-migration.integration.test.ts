import type Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../index';
import {
    databaseBeforeMigration,
    seedCreatorLinkedSessions,
} from './session-relation-migration.fixture';

const MIGRATION_TAG = '0007_delegation_questions';

function seed(database: Database.Database): void {
    seedCreatorLinkedSessions(database);
    database.exec(`
        INSERT INTO agent_delegations (id, session_id, record_json)
            VALUES ('delegation-1', 'session-created', '{"receipt":{"status":"running","terminalId":"terminal-1"}}');
    `);
}

async function upgrade() {
    const path = await databaseBeforeMigration(MIGRATION_TAG, seed);
    const upgraded = new CaxriDatabase(path);
    onTestFinished(() => upgraded.close());
    return upgraded;
}

const columns =
    'id, delegation_id, session_id, child_launch_id, child_generation, question_text, state, asked_at';

function insertOpen(database: CaxriDatabase, id: string): void {
    database.database
        .prepare(
            `INSERT INTO delegation_questions (${columns}) VALUES (?, 'delegation-1', 'session-created', 'launch-1', 1, 'Which one?', 'open', 10)`,
        )
        .run(id);
}

describe(`${MIGRATION_TAG} migration`, () => {
    it('keeps the existing delegation and stores a question for it', async () => {
        const upgraded = await upgrade();

        expect(upgraded.agentDelegations.questions.countForDelegation('delegation-1')).toBe(0);
        const stored = upgraded.agentDelegations.questions.insert({
            id: 'question-1',
            delegationId: 'delegation-1',
            sessionId: 'session-created',
            childLaunchId: 'launch-1',
            childGeneration: 3,
            requestId: 'request-1',
            text: 'Which one?',
            options: ['A', 'B'],
            askedAt: 10,
        });

        expect(stored).toMatchObject({
            id: 'question-1',
            state: 'open',
            options: ['A', 'B'],
            childLaunchId: 'launch-1',
            childGeneration: 3,
        });
        expect(upgraded.agentDelegations.questions.openForDelegation('delegation-1')).toEqual(
            stored,
        );
        expect(upgraded.database.pragma('foreign_key_check')).toEqual([]);
    });

    it.each([
        ['state', "UPDATE delegation_questions SET state = 'guessed'"],
        [
            'answered by',
            "UPDATE delegation_questions SET state = 'answered', answered_by = 'bot', answer_text = 'x', closed_at = 11",
        ],
        [
            'cancel reason',
            "UPDATE delegation_questions SET state = 'cancelled', cancel_reason = 'bored', closed_at = 11",
        ],
        [
            'escalation reason',
            "UPDATE delegation_questions SET escalated_at = 11, escalation_reason = 'late'",
        ],
        [
            'closed state: an answered row without an answer',
            "UPDATE delegation_questions SET state = 'answered', answered_by = 'user', closed_at = 11",
        ],
        ['escalation pairing', 'UPDATE delegation_questions SET escalated_at = 11'],
    ])('rejects a row outside the closed set (%s)', async (_label, statement) => {
        const upgraded = await upgrade();
        insertOpen(upgraded, 'question-1');

        expect(() => upgraded.database.prepare(statement).run()).toThrow(
            /CHECK constraint failed/u,
        );
    });

    it('allows one open question per delegation at a time', async () => {
        const upgraded = await upgrade();
        insertOpen(upgraded, 'question-1');

        expect(() => insertOpen(upgraded, 'question-2')).toThrow(/UNIQUE constraint failed/u);
        expect(
            upgraded.agentDelegations.questions.cancel('question-1', 'child_cancelled', 12),
        ).toBe(true);
        expect(() => insertOpen(upgraded, 'question-2')).not.toThrow();
    });

    it('removes the questions with their delegation', async () => {
        const upgraded = await upgrade();
        insertOpen(upgraded, 'question-1');
        upgraded.database.prepare("DELETE FROM agent_delegations WHERE id = 'delegation-1'").run();

        expect(upgraded.agentDelegations.questions.get('question-1')).toBeUndefined();
        expect(upgraded.database.pragma('foreign_key_check')).toEqual([]);
    });

    it('removes the questions with their Session', async () => {
        const upgraded = await upgrade();
        insertOpen(upgraded, 'question-1');
        upgraded.deleteSession('session-created');

        expect(upgraded.agentDelegations.questions.get('question-1')).toBeUndefined();
        expect(upgraded.database.pragma('foreign_key_check')).toEqual([]);
    });

    it('refuses a question for a delegation that does not exist', async () => {
        const upgraded = await upgrade();

        expect(() =>
            upgraded.database
                .prepare(
                    `INSERT INTO delegation_questions (${columns}) VALUES ('question-1', 'missing', 'session-created', 'launch-1', 1, 'Q', 'open', 10)`,
                )
                .run(),
        ).toThrow(/FOREIGN KEY constraint failed/u);
    });
});

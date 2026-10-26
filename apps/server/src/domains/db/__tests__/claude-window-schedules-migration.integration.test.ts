import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase, ClaudeWindowSchedulesModel } from '../index';
import { createDatabaseBeforeMigration, seedSessionWithChat } from './pre-migration.fixture';

describe('Claude window schedules table', () => {
    it('adds the table when upgrading from the schema version before it and keeps existing data', async () => {
        let projectId = '';
        const { path } = await createDatabaseBeforeMigration(
            '0011_claude_window_schedules',
            (raw) => {
                projectId = seedSessionWithChat(raw).projectId;
            },
        );

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());
        expect(upgraded.getProject(projectId)).toBeDefined();
        const schedules = new ClaudeWindowSchedulesModel(upgraded.database);
        expect(schedules.get('hash')).toBeUndefined();
        schedules.save({
            accountHash: 'hash',
            planType: 'pro',
            keepRolling: false,
            lastOutcome: { outcome: 'trigger_confirmed', at: 1, missedPlannedAt: 0 },
        });
        expect(schedules.get('hash')).toEqual({
            accountHash: 'hash',
            planType: 'pro',
            keepRolling: false,
            lastOutcome: { outcome: 'trigger_confirmed', at: 1, missedPlannedAt: 0 },
        });
        expect(() =>
            upgraded.database
                .prepare(
                    "UPDATE claude_window_schedules SET last_outcome = 'sent' WHERE account_hash = 'hash'",
                )
                .run(),
        ).toThrow(/CHECK/);
    });
});

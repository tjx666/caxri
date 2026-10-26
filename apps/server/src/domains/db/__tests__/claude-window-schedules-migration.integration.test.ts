import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../connection';
import { CaxriDatabase, ClaudeWindowSchedulesModel } from '../index';

describe('Claude window schedules table', () => {
    it('adds the table when upgrading from the schema version before it and keeps existing data', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-db-claude-windows-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const path = join(directory, 'state.db');
        const database = new CaxriDatabase(path);
        const project = database.createProject(join(directory, 'project'));
        database.close();
        const raw = new Database(path);
        raw.exec('DROP TABLE claude_window_schedules');
        raw.pragma(`user_version = ${CURRENT_SCHEMA_VERSION - 1}`);
        raw.close();

        const upgraded = new CaxriDatabase(path);
        onTestFinished(() => upgraded.close());
        expect(upgraded.getProject(project.id)).toBeDefined();
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

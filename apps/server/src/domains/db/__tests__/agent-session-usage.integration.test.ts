import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';

import { CURRENT_SCHEMA_VERSION } from '../connection';
import { CaxriDatabase } from '../index';
import { BASELINE_SCHEMA_VERSION } from '../migrations/manifest';

async function openDatabase() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-usage-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.db');
    return { directory, path, database: new CaxriDatabase(path) };
}

describe('Agent Session usage ledger', () => {
    it('records each Agent Session binding once and keeps it after the Session is deleted', async () => {
        const { directory, database } = await openDatabase();
        onTestFinished(() => database.close());
        const project = database.createProject(directory);
        const first = database.createSession(project.id, 'codex');
        const second = database.createSession(project.id, 'codex');

        expect(database.rebindAgentSession(first.terminal!.id, 'codex', 'codex-1')).toBe(true);
        // A resume of the same conversation in another Session keeps the Session that first paid for it.
        expect(database.rebindAgentSession(second.terminal!.id, 'codex', 'codex-1')).toBe(true);
        expect(database.rebindAgentSession(first.terminal!.id, 'codex', 'codex-2')).toBe(true);

        const rows = database.agentSessionUsage
            .list()
            .toSorted((a, b) => a.agentSessionId.localeCompare(b.agentSessionId));
        expect(rows).toMatchObject([
            { provider: 'codex', agentSessionId: 'codex-1', sessionId: first.session.id },
            { provider: 'codex', agentSessionId: 'codex-2', sessionId: first.session.id },
        ]);

        database.deleteSession(first.session.id);
        expect(database.agentSessionUsage.list()).toHaveLength(2);
    });

    it('stores scans and pull request outcomes', async () => {
        const { directory, database } = await openDatabase();
        onTestFinished(() => database.close());
        const project = database.createProject(directory);
        const { terminal } = database.createSession(project.id, 'claude');
        database.rebindAgentSession(terminal!.id, 'claude', 'claude-1');

        database.agentSessionUsage.saveScan('claude', 'claude-1', {
            sourceFingerprint: 'v1|10:1',
            scannedAt: 5,
            usageJson: '{}',
        });
        const outcome = {
            url: 'https://github.com/acme/widgets/pull/1',
            state: 'open' as const,
            title: 'Draft',
            createdAt: 1,
            mergedAt: null,
            additions: 1,
            deletions: 0,
            checkedAt: 2,
        };
        database.agentSessionUsage.savePullRequestOutcome(outcome);
        database.agentSessionUsage.savePullRequestOutcome({
            ...outcome,
            state: 'merged',
            mergedAt: 3,
        });

        expect(database.agentSessionUsage.list()[0]).toMatchObject({
            sourceFingerprint: 'v1|10:1',
            scannedAt: 5,
            usageJson: '{}',
        });
        expect(database.agentSessionUsage.listPullRequestOutcomes()).toEqual([
            { ...outcome, state: 'merged', mergedAt: 3 },
        ]);
    });

    it('caches transcripts found outside the ledger, one row per file', async () => {
        const { database } = await openDatabase();
        onTestFinished(() => database.close());
        const row = {
            provider: 'codex' as const,
            transcriptId: 'rollout-2',
            agentSessionId: 'thread-1',
            path: '/transcripts/rollout-2.jsonl',
            cwd: null,
            sourceFingerprint: 'v1|10:1',
            scannedAt: 5,
            usageJson: '{}',
        };
        database.agentSessionUsage.saveExternalScan(row);
        database.agentSessionUsage.saveExternalScan({ ...row, cwd: '/work', scannedAt: 6 });

        expect(database.agentSessionUsage.listExternal()).toEqual([
            { ...row, cwd: '/work', scannedAt: 6 },
        ]);
    });

    it('creates the usage tables when upgrading from each earlier schema version', async () => {
        /**
         * Absolute versions: `0002_agent_session_usage` is schema 40 and `0003_external_agent_usage` schema 41. Every
         * later table is dropped too, because a database at either version predates it.
         */
        const laterTables = ['commander_tasks', 'commander_pending_notices'];
        const upgrades = [
            {
                from: BASELINE_SCHEMA_VERSION + 1,
                drop: ['agent_session_usage', 'pull_request_outcomes', 'external_agent_usage'],
            },
            { from: BASELINE_SCHEMA_VERSION + 2, drop: ['external_agent_usage'] },
        ];
        for (const { from, drop } of upgrades) {
            // eslint-disable-next-line no-await-in-loop -- each upgrade gets its own database
            const { path, database } = await openDatabase();
            database.close();
            const raw = new Database(path);
            for (const table of [...drop, ...laterTables]) raw.exec(`DROP TABLE ${table}`);
            raw.pragma(`user_version = ${from}`);
            raw.close();

            const upgraded = new CaxriDatabase(path);
            onTestFinished(() => upgraded.close());
            expect(upgraded.agentSessionUsage.list()).toEqual([]);
            expect(upgraded.agentSessionUsage.listPullRequestOutcomes()).toEqual([]);
            expect(upgraded.agentSessionUsage.listExternal()).toEqual([]);
            const check = new Database(path, { readonly: true });
            onTestFinished(() => {
                check.close();
            });
            expect(check.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
        }
    });
});

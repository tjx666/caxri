import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { CaxriDatabase } from '../index';

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
            openedAt: 1,
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
});

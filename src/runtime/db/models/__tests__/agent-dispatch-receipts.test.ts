import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AgentDispatchLaunch } from '../../../../shared/ipc/agent-dispatch-contract';
import { CaxriDatabaseConnection as CaxriDatabase } from '../../index';
import type { NewAgentDispatchReceipt } from '../agent-dispatch-receipts';

const MAX_DISPATCH_RECEIPTS = 1_024;

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directoriesToRemove = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

async function openDatabase(prefix: string): Promise<CaxriDatabase> {
    const directory = await temporaryDirectory(prefix);
    return new CaxriDatabase(join(directory, 'state.db'));
}

function makeLaunch(): AgentDispatchLaunch {
    return {
        provider: 'codex',
        mode: 'fresh',
        executable: '/usr/bin/codex',
        argumentCount: 0,
        fingerprint: '0'.repeat(64),
    };
}

function makeInput(
    dispatchId: string,
    overrides: Partial<NewAgentDispatchReceipt> = {},
): NewAgentDispatchReceipt {
    return {
        dispatchId,
        requestFingerprint: `fingerprint-${dispatchId}`,
        operation: 'start',
        projectId: 'project-1',
        sessionId: 'session-1',
        provider: 'codex',
        requestedLaunch: makeLaunch(),
        effectiveLaunch: makeLaunch(),
        now: Date.now(),
        ...overrides,
    };
}

/**
 * Inserts a receipt row directly through raw SQL, bypassing the model, so bulk fixtures for the bounded-retention tests
 * below stay fast (no per-row Zod validation or JSON round-trip needed).
 */
function insertRawReceipt(
    database: CaxriDatabase,
    dispatchId: string,
    status: string,
    updatedAt: number,
): void {
    const launchJson = JSON.stringify(makeLaunch());
    database.database
        .prepare(
            `INSERT INTO agent_dispatch_receipts
             (dispatch_id, request_fingerprint, operation, status, project_id, session_id,
              terminal_id, provider, requested_launch_json, effective_launch_json,
              endpoint_json, failure_json, revision, created_at, updated_at)
             VALUES (?, ?, 'start', ?, 'project-1', 'session-1', NULL, 'codex', ?, ?, NULL, NULL, 1, ?, ?)`,
        )
        .run(
            dispatchId,
            `fingerprint-${dispatchId}`,
            status,
            launchJson,
            launchJson,
            updatedAt,
            updatedAt,
        );
}

function insertRawReceiptsInBulk(database: CaxriDatabase, count: number, status: string): void {
    database.database.transaction(() => {
        for (let index = 0; index < count; index += 1)
            insertRawReceipt(
                database,
                `bulk-${String(index).padStart(5, '0')}`,
                status,
                1_000 + index,
            );
    })();
}

describe('AgentDispatchReceiptsModel', () => {
    it('round-trips an inserted receipt', async () => {
        const database = await openDatabase('caxri-dispatch-round-trip-');
        const now = Date.now();
        const input = makeInput('dispatch-1', { now, requestFingerprint: 'fingerprint-a' });

        const stored = database.agentDispatchReceipts.insert(input);

        expect(stored.requestFingerprint).toBe('fingerprint-a');
        expect(stored.receipt).toMatchObject({
            dispatchId: 'dispatch-1',
            operation: 'start',
            status: 'requested',
            projectId: 'project-1',
            sessionId: 'session-1',
            provider: 'codex',
            requestedLaunch: makeLaunch(),
            effectiveLaunch: makeLaunch(),
            revision: 1,
            createdAt: now,
            updatedAt: now,
        });
        expect(stored.receipt.terminalId).toBeUndefined();
        expect(database.agentDispatchReceipts.get('dispatch-1')).toEqual(stored);
        database.close();
    });

    it('returns undefined for an unknown dispatch id', async () => {
        const database = await openDatabase('caxri-dispatch-missing-');

        expect(database.agentDispatchReceipts.get('missing')).toBeUndefined();
        database.close();
    });

    it('increments revision and updates fields on update', async () => {
        const database = await openDatabase('caxri-dispatch-revision-');
        const now = Date.now();
        database.agentDispatchReceipts.insert(makeInput('dispatch-2', { now }));

        const updated = database.agentDispatchReceipts.update('dispatch-2', {
            status: 'running',
            now: now + 1,
        });
        expect(updated.receipt).toMatchObject({
            status: 'running',
            revision: 2,
            updatedAt: now + 1,
        });

        const updatedAgain = database.agentDispatchReceipts.update('dispatch-2', {
            status: 'stopped',
            now: now + 2,
        });
        expect(updatedAgain.receipt).toMatchObject({
            status: 'stopped',
            revision: 3,
            updatedAt: now + 2,
        });
        database.close();
    });

    it('throws NOT_FOUND when updating a dispatch id that does not exist', async () => {
        const database = await openDatabase('caxri-dispatch-update-missing-');

        expect(() =>
            database.agentDispatchReceipts.update('missing', {
                status: 'running',
                now: Date.now(),
            }),
        ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }) as Error);
        database.close();
    });

    it('evicts the oldest settled receipt first once the cap is exceeded', async () => {
        const database = await openDatabase('caxri-dispatch-eviction-');
        insertRawReceiptsInBulk(database, MAX_DISPATCH_RECEIPTS, 'stopped');
        const oldestId = 'bulk-00000';
        const survivorId = 'bulk-00001';
        expect(database.agentDispatchReceipts.get(oldestId)).toBeDefined();

        const stored = database.agentDispatchReceipts.insert(makeInput('dispatch-new'));

        expect(database.agentDispatchReceipts.get(oldestId)).toBeUndefined();
        expect(database.agentDispatchReceipts.get(survivorId)).toBeDefined();
        expect(database.agentDispatchReceipts.get('dispatch-new')).toEqual(stored);
        expect(
            (
                database.database
                    .prepare('SELECT COUNT(*) AS count FROM agent_dispatch_receipts')
                    .get() as { count: number }
            ).count,
        ).toBe(MAX_DISPATCH_RECEIPTS);
        database.close();
    });

    it('throws CAPACITY when the cap is still exceeded after pruning because rows are unsettled', async () => {
        const database = await openDatabase('caxri-dispatch-capacity-');
        insertRawReceiptsInBulk(database, MAX_DISPATCH_RECEIPTS, 'running');

        expect(() => database.agentDispatchReceipts.insert(makeInput('dispatch-overflow'))).toThrow(
            expect.objectContaining({ code: 'CAPACITY' }) as Error,
        );
        database.close();
    });

    it('throws INTERNAL when a stored launch JSON cell is corrupt', async () => {
        const database = await openDatabase('caxri-dispatch-corrupt-');
        database.agentDispatchReceipts.insert(makeInput('dispatch-corrupt'));
        database.database
            .prepare(
                'UPDATE agent_dispatch_receipts SET requested_launch_json = ? WHERE dispatch_id = ?',
            )
            .run('{not-json', 'dispatch-corrupt');

        expect(() => database.agentDispatchReceipts.get('dispatch-corrupt')).toThrow(
            expect.objectContaining({ code: 'INTERNAL' }) as Error,
        );
        database.close();
    });
});

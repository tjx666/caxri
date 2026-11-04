import { describe, expect, it, vi } from 'vitest';

import { delegatedFixture } from '../../__tests__/delegated-sessions.fixture';
import { readHistory } from '../read';
import { historyRow, principalHash } from '../row';
import { recordSettlement, shouldRecordHistory } from '../settlement';

type Fixture = Awaited<ReturnType<typeof delegatedFixture>>;

const owner = { principal: { kind: 'human-cli' as const, id: 'owner' } };

function historyRows(f: Fixture) {
    return f.database.database
        .prepare('SELECT * FROM delegation_history ORDER BY created_at, delegation_id')
        .all() as Array<Record<string, unknown>>;
}

describe('delegation history rows', () => {
    it('writes one row when a task settles, with the title snapshot and a bounded summary', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();
        expect(historyRows(f)).toEqual([]);

        await f.finish(task, 'Long analysis.\n\nSummary: Found two out-of-order migrations.');

        const [row] = historyRows(f);
        expect(historyRows(f)).toHaveLength(1);
        expect(row).toMatchObject({
            delegation_id: task.id,
            root_delegation_id: task.id,
            retry_of: null,
            session_id: task.receipt.sessionId,
            project_id: f.project.id,
            owner_terminal_id: f.authority.callerTerminalId,
            owner_principal_hash: principalHash(f.authority.principal),
            provider: 'claude',
            outcome: 'completed',
            failure: null,
            title: 'Check the retry design',
            summary: 'Found two out-of-order migrations.',
            summary_source: 'authored',
            input_tokens: null,
            usage_scope: null,
            compacted_at: null,
        });
        expect(row).not.toHaveProperty('prompt');
    });

    it('is idempotent when the same settled task is saved again', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();
        await f.finish(task, 'Summary: Done.');
        const before = historyRows(f);

        await f.service.result(task.id, f.authority);
        await f.service.result(task.id, f.authority);

        expect(historyRows(f)).toEqual(before);
    });

    it('records the provenance edge when the Session is created, before any task settles', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();

        expect(
            f.database.database
                .prepare(
                    'SELECT parent_session_id, relation FROM delegation_edges WHERE session_id = ?',
                )
                .get(task.receipt.sessionId),
        ).toEqual({ parent_session_id: f.callerSessionId, relation: 'delegated' });
        expect(historyRows(f)).toEqual([]);
    });

    it('keeps the edge when the unsettled child or its parent is deleted', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();
        const sessionId = task.receipt.sessionId;

        f.database.deleteSession(sessionId);
        f.database.deleteSession(f.callerSessionId);

        expect(
            f.database.database
                .prepare(
                    'SELECT parent_session_id, relation FROM delegation_edges WHERE session_id = ?',
                )
                .get(sessionId),
        ).toEqual({ parent_session_id: f.callerSessionId, relation: 'delegated' });
    });

    it('stores no title when the Session is already gone at settle', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();
        f.database.deleteSession(task.receipt.sessionId);
        const stored = f.database.agentDelegations.get(task.id);

        // The task record cascades away with its Session, so settle a copy the way a late save would.
        if (stored) {
            const row = historyRow(
                { ...stored, receipt: { ...stored.receipt, status: 'interrupted' } },
                undefined,
            );
            expect(row.title).toBeNull();
        }
    });

    it('records a re-settle without keeping a stale summary, and a compacted row keeps no text', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();
        await f.finish(task, 'Summary: Done.');
        const stored = f.database.agentDelegations.get(task.id)!;
        const { history } = f.database.agentDelegations;

        history.record(
            historyRow(
                {
                    ...stored,
                    receipt: { ...stored.receipt, status: 'human_intervened' },
                    answer: undefined,
                },
                'Check the retry design',
            ),
            5000,
            9,
        );

        expect(historyRows(f)[0]).toMatchObject({
            outcome: 'human_intervened',
            summary: null,
            summary_source: null,
            title: 'Check the retry design',
        });

        f.database.database
            .prepare(
                'UPDATE delegation_history SET title = NULL, summary = NULL, summary_source = NULL, compacted_at = 5',
            )
            .run();
        history.record(
            historyRow({ ...stored, receipt: { ...stored.receipt, status: 'failed' } }, 'Back'),
            5000,
            10,
        );
        expect(historyRows(f)[0]).toMatchObject({
            outcome: 'failed',
            title: null,
            summary: null,
            compacted_at: 5,
        });
    });

    it('compacts only the text of rows past the newest by settle time and deletes none', async () => {
        const f = await delegatedFixture();
        const task = await f.delegate();
        await f.finish(task, 'Summary: Done.');
        const stored = f.database.agentDelegations.get(task.id)!;
        const { history } = f.database.agentDelegations;
        const make = (id: string, createdAt: number, settledAt: number) => ({
            ...historyRow(stored, `Title ${id}`),
            delegationId: id,
            rootDelegationId: id,
            createdAt,
            settledAt,
        });

        // `late` was created long ago but settled now, so it is recent work and keeps its text.
        const results = [
            history.record(make('late', 1, 900), 3, 1000),
            history.record(make('a', 10, 20), 3, 1000),
            history.record(make('b', 11, 30), 3, 1000),
        ];

        expect(results.map((result) => result.compactedCount)).toEqual([0, 0, 1]);
        const rows = historyRows(f);
        expect(rows).toHaveLength(4);
        const byId = new Map(rows.map((row) => [row.delegation_id, row]));
        expect(byId.get('a')).toMatchObject({ title: null, compacted_at: 1000 });
        expect(byId.get('late')).toMatchObject({ title: 'Title late', compacted_at: null });
        expect(byId.get(task.id)).toMatchObject({ compacted_at: null });
    });
});

describe('recordSettlement', () => {
    it('keeps save() working and announced when the history write throws, then retries on the next save', async () => {
        const onReceiptChanged = vi.fn();
        const logger = {
            write: vi.fn<
                (level: string, event: string, entry: { fields: Record<string, unknown> }) => void
            >(),
        };
        const f = await delegatedFixture({
            onReceiptChanged,
            logger: logger as never,
        });
        const task = await f.delegate();
        const record = vi
            .spyOn(f.database.agentDelegations.history, 'record')
            .mockImplementationOnce(() => {
                throw Object.assign(new Error('secret SQL value'), {
                    code: 'SQLITE_CONSTRAINT_CHECK',
                });
            });

        await f.finish(task, 'Summary: Done.');

        expect(record).toHaveBeenCalledTimes(1);
        expect(historyRows(f)).toEqual([]);
        expect(onReceiptChanged).toHaveBeenCalled();
        const failure = logger.write.mock.calls.find(
            ([, event]) => event === 'agent_delegation.history_recorded',
        );
        expect(failure?.[2].fields).toMatchObject({
            result: 'failed',
            reason: 'constraint',
            delegationId: task.id,
        });
        expect(JSON.stringify(logger.write.mock.calls)).not.toContain('secret SQL value');

        // The task is settled with no row, so any later save of it retries.
        const saved = f.database.agentDelegations.get(task.id)!;
        recordSettlement(f.database, saved, saved, logger as never);
        expect(historyRows(f)).toHaveLength(1);
    });

    it.each([
        ['an active task', 'running', 'running', false, false],
        ['a task that just settled', 'running', 'completed', true, true],
        ['a settled task with a row', 'completed', 'completed', true, false],
        ['a settled task with no row', 'completed', 'completed', false, true],
        ['a settled task whose outcome changed', 'completed', 'human_intervened', true, true],
    ] as const)('decides for %s', (_name, before, after, hasRow, expected) => {
        const make = (status: string) => ({ receipt: { status } }) as never;

        expect(shouldRecordHistory(make(after), make(before), hasRow)).toBe(expected);
    });
});

describe('reading history', () => {
    async function settled(f: Fixture, title: string, summary: string) {
        const task = await f.delegate();
        f.database.renameSession(task.receipt.sessionId, title);
        await f.finish(task, `Summary: ${summary}`);
        return task;
    }

    it('searches title and summary literally and case-insensitively', async () => {
        const f = await delegatedFixture();
        await settled(f, 'Audit 100%_done', 'plain');
        await settled(f, 'Other', 'Migration NOTES here');

        const page = (query: string) =>
            readHistory(f.database, owner, { query, limit: 20 }).entries.map(
                (entry) => entry.title,
            );

        expect(page('100%_d')).toEqual(['Audit 100%_done']);
        expect(page('100x_d')).toEqual([]);
        expect(page('migration notes')).toEqual(['Other']);
        expect(page('\\')).toEqual([]);
    });

    it('filters by outcome and never matches fields other than title and summary', async () => {
        const f = await delegatedFixture();
        const task = await settled(f, 'Alpha', 'beta');

        expect(readHistory(f.database, owner, { outcome: 'failed', limit: 20 }).entries).toEqual(
            [],
        );
        expect(readHistory(f.database, owner, { query: task.id, limit: 20 }).entries).toEqual([]);
        expect(readHistory(f.database, owner, { query: 'codex', limit: 20 }).entries).toEqual([]);
    });

    it('pages by keyset across equal creation times without duplicates or gaps', async () => {
        const f = await delegatedFixture();
        const task = await settled(f, 'Seed', 'seed');
        const stored = f.database.agentDelegations.get(task.id)!;
        for (let index = 0; index < 120; index += 1)
            f.database.agentDelegations.history.record(
                {
                    ...historyRow(stored, `Row ${index}`),
                    delegationId: `task-${String(index).padStart(3, '0')}`,
                    rootDelegationId: `task-${String(index).padStart(3, '0')}`,
                    createdAt: 5000 + (index % 3),
                    settledAt: 6000,
                },
                5000,
                7000,
            );

        const seen: string[] = [];
        let after: string | undefined;
        do {
            const page = readHistory(f.database, owner, { limit: 50, after });
            seen.push(...page.entries.map((entry) => entry.delegationId));
            after = page.nextCursor;
        } while (after);

        expect(seen).toHaveLength(121);
        expect(new Set(seen).size).toBe(121);
    });

    it('refuses a cursor from another query, outcome, caller, or a tampered one', async () => {
        const f = await delegatedFixture();
        await settled(f, 'One', 'a');
        await settled(f, 'Two', 'b');
        const first = readHistory(f.database, owner, { query: 'o', limit: 1 });
        const agent = { ...f.authority };
        const refused = (
            parameters: Parameters<typeof readHistory>[2],
            authority: Parameters<typeof readHistory>[1] = owner,
        ) =>
            expect(() => readHistory(f.database, authority, parameters)).toThrow(
                expect.objectContaining({
                    code: 'VALIDATION',
                    details: { reason: 'history_cursor_invalid' },
                }),
            );

        expect(first.nextCursor).toBeDefined();
        const after = first.nextCursor!;
        refused({ query: 'x', limit: 1, after });
        refused({ query: 'o', outcome: 'failed', limit: 1, after });
        refused({ query: 'o', limit: 1, after }, agent);
        refused({ query: 'o', limit: 1, after: `${after.slice(0, -2)}AA` });
        refused({ query: 'o', limit: 1, after: 'not-a-cursor' });
        expect(
            readHistory(f.database, owner, { query: 'o', limit: 1, after }).entries,
        ).toHaveLength(1);
    });

    it('does not claim the answer', async () => {
        const f = await delegatedFixture();
        const task = await settled(f, 'Claim', 'x');
        const before = f.database.agentDelegations.get(task.id)!;

        readHistory(f.database, owner, { limit: 20 });

        expect(f.database.agentDelegations.get(task.id)).toEqual(before);
        expect(f.database.agentDelegations.get(task.id)?.collectedAt).toBeUndefined();
    });

    it('logs only closed fields, never the query, cursor, title, summary, or principal', async () => {
        const f = await delegatedFixture();
        await settled(f, 'SECRET-title-needle', 'SECRET-summary-needle');
        const logger = {
            write: vi.fn<
                (level: string, event: string, entry: { fields: Record<string, unknown> }) => void
            >(),
        };

        const page = readHistory(
            f.database,
            f.authority,
            { query: 'SECRET-needle-%', limit: 1 },
            logger as never,
        );
        readHistory(f.database, f.authority, { query: 'SECRET', limit: 1 }, logger as never);
        expect(page.entries).toEqual([]);
        expect(() =>
            readHistory(f.database, f.authority, { limit: 1, after: 'bad' }, logger as never),
        ).toThrow();

        const logged = JSON.stringify(logger.write.mock.calls);
        for (const secret of [
            'SECRET',
            'needle',
            'bad',
            'endpointId',
            f.authority.callerTerminalId,
        ])
            expect(logged).not.toContain(secret);
        expect(logger.write.mock.calls[0][2].fields).toEqual({
            principalKind: 'agent',
            outcomeFilter: 'none',
            hasQuery: true,
            queryLength: '9-32',
            entryCount: 0,
            hasMore: false,
            durationMs: expect.any(Number) as number,
            result: 'ok',
        });
        expect(logger.write.mock.calls[2][2].fields).toMatchObject({ result: 'cursor_invalid' });
    });
});

import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { ConfigService } from '../../config';
import type { CaxriDatabaseConnection } from '../../db';
import { CaxriDatabase } from '../../db';
import { createWorkbenchSnapshots } from '../snapshot';

const byId = (left: string, right: string) => left.localeCompare(right);
const config = {
    getErrors: () => [],
    getKeybindings: () => ({ value: [], conflicts: [] }),
    getSettings: () => ({ value: {} }),
    getTheme: () => ({ value: {} }),
} as unknown as ConfigService;

async function fixture(
    counts: { active: number; archived: number },
    logger?: Parameters<typeof createWorkbenchSnapshots>[0]['logger'],
) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-snapshot-archived-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const project = database.createProject(join(directory, 'project'));
    // The 32-Terminal cap guards `createSession`; a long-lived profile holds one Terminal per archived Session.
    const connection = (database as unknown as { db: CaxriDatabaseConnection }).db;
    const create = () => {
        const session = connection.sessions.insert({ projectId: project.id, title: 'Seeded' });
        const terminal = connection.terminals.insert({
            sessionId: session.id,
            kind: 'claude',
            cwd: directory,
            title: 'Claude',
        });
        connection.sessions.insertInitialState(session.id, terminal.id);
        return session;
    };
    const active = Array.from({ length: counts.active }, create);
    const archived = Array.from({ length: counts.archived }, create);
    for (const session of archived) database.archiveSession(session.id);
    const snapshots = createWorkbenchSnapshots({
        automaticNamingNotices: () => [],
        configuration: config,
        database,
        liveTerminalRecord: (terminal) => terminal,
        logger,
    });
    return { active, archived, database, snapshots };
}

describe('app.bootstrap scope', () => {
    it('keeps archived Session records but reads no Session state for them', async () => {
        const { active, archived, snapshots } = await fixture({ active: 3, archived: 4 });
        const state = snapshots.bootstrap();
        expect(state.sessions.map(({ id }) => id).toSorted(byId)).toEqual(
            [...active, ...archived].map(({ id }) => id).toSorted(byId),
        );
        expect(state.sessionStates.map(({ sessionId }) => sessionId).toSorted(byId)).toEqual(
            active.map(({ id }) => id).toSorted(byId),
        );
    });

    it('logs row counts and build time for each snapshot without row contents', async () => {
        const writes: Array<{ event: string; options: unknown }> = [];
        const logger = {
            write: (_level: string, event: string, options: unknown) =>
                writes.push({ event, options }),
        } as unknown as Parameters<typeof createWorkbenchSnapshots>[0]['logger'];
        const { snapshots } = await fixture({ active: 3, archived: 4 }, logger);
        snapshots.bootstrap();
        expect(writes).toHaveLength(1);
        expect(writes[0].event).toBe('workbench_snapshot.built');
        expect(writes[0].options).toMatchObject({
            durationMs: expect.any(Number) as number,
            fields: {
                archivedSessions: 4,
                sessions: 3,
                sessionStates: 3,
                terminals: 3,
                archivedTerminals: 4,
            },
        });
    });

    it('sends archived Sessions only a slim Terminal summary and restores the full record', async () => {
        const { active, archived, database, snapshots } = await fixture({ active: 1, archived: 2 });
        const state = snapshots.bootstrap();
        expect(state.terminals.map(({ sessionId }) => sessionId)).toEqual([active[0].id]);
        expect(state.archivedTerminals.map(({ sessionId }) => sessionId).toSorted(byId)).toEqual(
            archived.map(({ id }) => id).toSorted(byId),
        );
        expect(Object.keys(state.archivedTerminals[0]).toSorted(byId)).toEqual([
            'id',
            'kind',
            'orderIndex',
            'sessionId',
        ]);
        database.unarchiveSessions([archived[0].id]);
        const restored = snapshots.bootstrap();
        expect(restored.terminals.map(({ sessionId }) => sessionId)).toContain(archived[0].id);
        expect(restored.archivedTerminals.map(({ sessionId }) => sessionId)).not.toContain(
            archived[0].id,
        );
    });

    it('delivers the state again once a Session is restored', async () => {
        const { archived, database, snapshots } = await fixture({ active: 1, archived: 2 });
        database.unarchiveSessions([archived[0].id]);
        expect(snapshots.bootstrap().sessionStates.map(({ sessionId }) => sessionId)).toContain(
            archived[0].id,
        );
    });

    it.skipIf(!process.env.CAXRI_BENCH_ARCHIVE)(
        'measures the large-archive fixture',
        async () => {
            const rows: unknown[] = [];
            for (const archived of [0, 1000, 3000]) {
                // eslint-disable-next-line no-await-in-loop -- one fixture at a time keeps timings comparable
                const { database, snapshots } = await fixture({ active: 45, archived });
                const time = (run: () => void) => {
                    const start = performance.now();
                    run();
                    return Number((performance.now() - start).toFixed(2));
                };
                for (let warm = 0; warm < 3; warm += 1) snapshots.bootstrap();
                const samples: number[] = [];
                for (let run = 0; run < 20; run += 1) {
                    const start = performance.now();
                    snapshots.bootstrap();
                    samples.push(performance.now() - start);
                }
                samples.sort((left, right) => left - right);
                rows.push({
                    archived,
                    bytes: JSON.stringify(snapshots.bootstrap()).length,
                    // The sweep's former list phase (every Session, then one binding read each) against the single query.
                    sweepListBeforeMs: time(() => {
                        for (const { id } of database.listSessions())
                            database.getSessionWorkbenchBinding(id);
                    }),
                    sweepListAfterMs: time(() => database.listActiveWorktreeBindings()),
                    p50Ms: Number(samples[10].toFixed(2)),
                });
            }
            writeFileSync(process.env.CAXRI_BENCH_ARCHIVE!, `${JSON.stringify(rows)}\n`);
        },
        600_000,
    );
});

describe('listActiveWorktreeBindings', () => {
    it('returns only unarchived Sessions bound to another Project', async () => {
        const { active, archived, database } = await fixture({ active: 2, archived: 1 });
        const owner = database.listProjects()[0];
        const worktree = database.createProject(`${owner.rootPath}-worktree`);
        for (const session of [active[0], archived[0]])
            database.selectWorkbenchProject(session.id, worktree.id);
        expect(database.listActiveWorktreeBindings()).toMatchObject([
            {
                sessionId: active[0].id,
                binding: { projectId: owner.id, workbenchRootProjectId: worktree.id },
            },
        ]);
    });
});

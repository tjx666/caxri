import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import type { ConfigService } from '../../config';
import type { CaxriDatabaseConnection } from '../../db';
import { CaxriDatabase } from '../../db';
import { createWorkbenchSnapshots } from '../snapshot';

const config = {
    getErrors: () => [],
    getKeybindings: () => ({ value: [], conflicts: [] }),
    getSettings: () => ({ value: {} }),
    getTheme: () => ({ value: {} }),
} as unknown as ConfigService;

/**
 * Serialized bytes one archived Session may add to `app.bootstrap`: its record plus its slim Terminal summary. The slim
 * shape measures about 0.5 KiB; the budget leaves headroom for new fields and still fails if a full Terminal row or
 * `session_state` leaks back in. Documented in `project-architecture/references/performance.md`.
 */
const ARCHIVED_BYTES_PER_SESSION_BUDGET = 1024;

async function bootstrapWith(counts: { active: number; archived: number }) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-snapshot-scale-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const project = database.createProject(join(directory, 'project'));
    // Direct inserts bypass the per-Project Terminal cap, as a long-lived profile accumulates one per archived Session.
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

    // Counts every call the snapshot builder makes on the database, so the test sees reads, not wall-clock time.
    const calls = new Map<string, number>();
    const counted = new Proxy(database, {
        get(target, property, receiver) {
            const value: unknown = Reflect.get(target, property, receiver);
            if (typeof value !== 'function') return value;
            return (...arguments_: unknown[]) => {
                calls.set(String(property), (calls.get(String(property)) ?? 0) + 1);
                return (value as (...parameters: unknown[]) => unknown).apply(target, arguments_);
            };
        },
    });
    const snapshots = createWorkbenchSnapshots({
        automaticNamingNotices: () => [],
        configuration: config,
        database: counted,
        liveTerminalRecord: (terminal) => terminal,
    });
    return { active, archived, calls, state: snapshots.bootstrap() };
}

describe('app.bootstrap scale with archived history', () => {
    it('keeps each archived Session within a bounded payload', async () => {
        const { active, archived, state } = await bootstrapWith({ active: 5, archived: 500 });
        const archivedIds = new Set(archived.map(({ id }) => id));
        const bytes = (value: unknown) => JSON.stringify(value).length;
        const archivedBytes =
            bytes(state.sessions.filter((session) => archivedIds.has(session.id))) +
            bytes(state.archivedTerminals);
        expect(state.archivedTerminals).toHaveLength(archived.length);
        expect(state.terminals).toHaveLength(active.length);
        expect(archivedBytes / archived.length).toBeLessThan(ARCHIVED_BYTES_PER_SESSION_BUDGET);
    });

    it('issues the same database reads however many Sessions are archived', async () => {
        const small = await bootstrapWith({ active: 5, archived: 10 });
        const large = await bootstrapWith({ active: 5, archived: 500 });
        // Equal call counts mean no per-archived-Session query (a `session_state` or binding read per row).
        expect(Object.fromEntries(large.calls)).toEqual(Object.fromEntries(small.calls));
        expect(large.state.sessionStates).toHaveLength(5);
    }, 60_000);
});

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { DatabaseOpening } from '../connection';
import { CaxriDatabaseConnection as CaxriDatabase } from '../index';
import type * as ManifestModule from '../migrations/manifest';
import { BASELINE_SCHEMA_VERSION } from '../migrations/manifest';

/**
 * One post-baseline migration this file appends after the shipped chain, so a database stamped with the shipped version
 * has exactly one step pending through the real `openDatabase` upgrade path.
 */
const appended = vi.hoisted(() => ({ sql: [] as string[] }));

vi.mock('../migrations/manifest', async (importOriginal) => {
    const shipped = await importOriginal<typeof ManifestModule>();
    return {
        ...shipped,
        get CURRENT_SCHEMA_VERSION() {
            return shipped.CURRENT_SCHEMA_VERSION + appended.sql.length;
        },
        get migrationsAfterBaseline() {
            return [
                ...shipped.migrationsAfterBaseline,
                ...appended.sql.map((sql, index) => ({
                    tag: `test_opening_${index}`,
                    sql,
                    version: shipped.CURRENT_SCHEMA_VERSION + index + 1,
                })),
            ];
        },
    };
});

async function databasePath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-opening-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    appended.sql = [];
    return join(directory, 'state.db');
}

function open(path: string): { database: CaxriDatabase; opening: DatabaseOpening } {
    let opening: DatabaseOpening | undefined;
    const database = new CaxriDatabase(path, {
        onOpened: (report) => {
            opening = report;
        },
    });
    return { database, opening: opening! };
}

/**
 * A Session with one Shell and one Agent Terminal, both still recorded as running, as a killed Server Core leaves them.
 */
function seedLiveTerminals(database: CaxriDatabase, root: string): void {
    const project = database.projects.create(root);
    const session = database.sessions.insert({ projectId: project.id, title: 'Work' });
    const shell = database.terminals.insert({
        sessionId: session.id,
        kind: 'shell',
        cwd: root,
        title: 'Shell',
    });
    const agent = database.terminals.insert({
        sessionId: session.id,
        kind: 'codex',
        cwd: root,
        title: 'Codex',
    });
    database.terminals.updateState(shell.id, 'running');
    database.terminals.updateState(agent.id, 'running');
    database.terminals.updateAgentProcessState(agent.id, 'running');
}

describe('database opening report', () => {
    it('reports a new database as created and an unchanged reopen as current', async () => {
        const path = await databasePath();
        const created = open(path);
        const toVersion = created.database.database.pragma('user_version', { simple: true });
        created.database.close();
        expect(created.opening).toMatchObject({
            outcome: 'created',
            fromVersion: 0,
            toVersion,
            interruptedTerminals: 0,
            interruptedAgents: 0,
        });
        expect(created.opening.durationMs).toBeGreaterThanOrEqual(0);

        const current = open(path);
        current.database.close();
        expect(current.opening).toMatchObject({
            outcome: 'current',
            fromVersion: toVersion,
            toVersion,
        });
    });

    it('reports the pending post-baseline steps as migrated', async () => {
        const path = await databasePath();
        const shipped = open(path);
        const shippedVersion = shipped.database.database.pragma('user_version', {
            simple: true,
        }) as number;
        shipped.database.close();
        appended.sql = ['CREATE TABLE `opening_probe` (`id` integer PRIMARY KEY NOT NULL);'];

        const migrated = open(path);
        migrated.database.close();

        expect(migrated.opening).toMatchObject({
            outcome: 'migrated',
            fromVersion: shippedVersion,
            toVersion: shippedVersion + 1,
        });
    });

    it('reports a pre-baseline database as rebuilt', async () => {
        const path = await databasePath();
        const previous = open(path);
        previous.database.database.pragma(`user_version = ${BASELINE_SCHEMA_VERSION - 1}`);
        previous.database.close();

        const rebuilt = open(path);
        rebuilt.database.close();

        expect(rebuilt.opening).toMatchObject({
            outcome: 'rebuilt',
            fromVersion: BASELINE_SCHEMA_VERSION - 1,
        });
        expect(rebuilt.opening.droppedTableCount).toBeGreaterThan(0);
    });

    it('persists the latest rebuild with its existing backup, and nothing without one', async () => {
        const path = await databasePath();
        const fresh = open(path);
        expect(fresh.database.appState.get('lastDatabaseRebuild')).toBeUndefined();
        expect(fresh.opening.droppedTableCount).toBe(0);
        fresh.database.database.pragma(`user_version = ${BASELINE_SCHEMA_VERSION - 1}`);
        fresh.database.close();

        const before = Date.now();
        const rebuilt = open(path);
        const record = rebuilt.database.appState.get('lastDatabaseRebuild');
        rebuilt.database.close();

        expect(record).toMatchObject({ fromVersion: BASELINE_SCHEMA_VERSION - 1 });
        expect(record!.at).toBeGreaterThanOrEqual(before);
        expect(record!.backupPath.startsWith(`${path}.v${BASELINE_SCHEMA_VERSION - 1}-`)).toBe(
            true,
        );
        expect(existsSync(record!.backupPath)).toBe(true);

        const reopened = open(path);
        const kept = reopened.database.appState.get('lastDatabaseRebuild');
        reopened.database.close();
        expect(kept).toEqual(record);
    });

    it('counts the live Terminal and Agent processes an unclean shutdown left behind', async () => {
        const path = await databasePath();
        const crashed = open(path);
        seedLiveTerminals(crashed.database, join(path, '..'));
        crashed.database.close();

        const recovered = open(path);
        recovered.database.close();

        expect(recovered.opening).toMatchObject({ interruptedTerminals: 2, interruptedAgents: 1 });
    });

    it('counts nothing after an orderly shutdown already marked the Terminals', async () => {
        const path = await databasePath();
        const stopped = open(path);
        seedLiveTerminals(stopped.database, join(path, '..'));
        stopped.database.markShutdown('orderly');
        stopped.database.close();

        const reopened = open(path);
        reopened.database.close();

        expect(reopened.opening).toMatchObject({ interruptedTerminals: 0, interruptedAgents: 0 });
    });
});

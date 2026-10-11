import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import * as schema from '../full-schema';
import { CaxriDatabase } from '../index';
import type * as ManifestModule from '../migrations/manifest';
import { drizzleKit } from './drizzle-kit.fixture';

/**
 * SQL of the post-baseline migrations this file appends after the shipped chain. Mocking the manifest runs them through
 * the real `openDatabase` upgrade path while the shipped migrations folder stays untouched.
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
                    tag: `test_rebuild_${index}`,
                    sql,
                    version: shipped.CURRENT_SCHEMA_VERSION + index + 1,
                })),
            ];
        },
    };
});

/**
 * `drizzle-kit generate` writes a migration file by joining its statements with this breakpoint.
 */
const STATEMENT_BREAKPOINT = '--> statement-breakpoint\n';
const ADDED_CHECK = 'projects_order_index_non_negative';

/**
 * The migration `drizzle-kit generate` writes when `projects` gains a CHECK constraint. SQLite cannot add one in place,
 * so drizzle-kit emits its create-copy-drop-rename rebuild of this parent table, bracketed by `PRAGMA
 * foreign_keys=OFF;` and `PRAGMA foreign_keys=ON;`.
 */
async function generatedProjectsRebuild(): Promise<string> {
    const previous = await drizzleKit.generateSQLiteDrizzleJson(schema);
    const current = structuredClone(previous);
    current.tables.projects.checkConstraints[ADDED_CHECK] = {
        name: ADDED_CHECK,
        value: '"projects"."order_index" >= 0',
    };
    const sql = (await drizzleKit.generateSQLiteMigration(previous, current)).join(
        STATEMENT_BREAKPOINT,
    );
    expect(sql).toContain('DROP TABLE `projects`;');
    expect(sql).toContain('PRAGMA foreign_keys=OFF;');
    return sql;
}

/**
 * The precedent before the runner owned the toggle: delete the two generated PRAGMA statements by hand.
 */
function withoutForeignKeysPragma(sql: string): string {
    const stripped = sql
        .split(STATEMENT_BREAKPOINT)
        .filter((statement) => !/^PRAGMA foreign_keys=(?:OFF|ON);$/u.test(statement.trim()))
        .join(STATEMENT_BREAKPOINT);
    expect(stripped).not.toMatch(/PRAGMA foreign_keys/u);
    return stripped;
}

/**
 * A shipped-schema database whose `projects` rows are parents of an owned worktree Project, a Session, and through it a
 * Terminal and its snapshot: every row a parent rebuild could cascade-delete.
 */
async function seededDatabase() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-db-rebuild-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'state.db');
    appended.sql = [];
    const database = new CaxriDatabase(path);
    const owner = database.createProject(join(directory, 'project'));
    const worktree = database.createProject(join(directory, 'project-worktree'), owner.id);
    const { session, terminal } = database.createSession(owner.id, 'codex');
    database.saveSnapshot({
        terminalId: terminal!.id,
        encodingVersion: 1,
        cols: 80,
        rows: 24,
        lineCount: 1,
        byteCount: 2,
        payload: 'hi',
        updatedAt: 1,
    });
    const shippedVersion = database.database.pragma('user_version', { simple: true }) as number;
    database.close();
    return { owner, path, session, shippedVersion, terminal: terminal!, worktree };
}

function projectsTableSql(database: CaxriDatabase): string {
    const row = database.database
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'projects'")
        .get() as { sql: string };
    return row.sql;
}

describe('table rebuild migrations', () => {
    it.each([
        { variant: 'as drizzle-kit generates it', prepare: (sql: string) => sql },
        {
            variant: 'with its PRAGMA statements deleted by hand',
            prepare: withoutForeignKeysPragma,
        },
    ])(
        'rebuilds the projects parent table $variant without cascading into its child rows',
        async ({ prepare }) => {
            const seeded = await seededDatabase();
            appended.sql = [prepare(await generatedProjectsRebuild())];

            const upgraded = new CaxriDatabase(seeded.path);
            onTestFinished(() => upgraded.close());

            expect(projectsTableSql(upgraded)).toContain(ADDED_CHECK);
            expect(upgraded.database.pragma('user_version', { simple: true })).toBe(
                seeded.shippedVersion + 1,
            );
            expect(upgraded.getProject(seeded.worktree.id)?.ownerProjectId).toBe(seeded.owner.id);
            expect(upgraded.getSession(seeded.session.id)).toMatchObject({
                projectId: seeded.owner.id,
                primaryAgentTerminalId: seeded.terminal.id,
            });
            expect(upgraded.getTerminal(seeded.terminal.id)?.sessionId).toBe(seeded.session.id);
            expect(upgraded.getSnapshot(seeded.terminal.id)?.payload).toBe('hi');
            expect(upgraded.database.pragma('foreign_keys', { simple: true })).toBe(1);
            expect(upgraded.database.pragma('foreign_key_check')).toEqual([]);
        },
    );

    it('rolls back a rebuild that leaves a dangling foreign key, reported by foreign_key_check', async () => {
        const seeded = await seededDatabase();
        const generated = await generatedProjectsRebuild();
        const copy = 'FROM `projects`;';
        expect(generated).toContain(copy);
        appended.sql = [generated.replace(copy, 'FROM `projects` WHERE 0;')];

        expect(() => new CaxriDatabase(seeded.path)).toThrow(
            /foreign_key_check found 1 violation\(s\): sessions -> projects/u,
        );

        appended.sql = [];
        const reopened = new CaxriDatabase(seeded.path);
        onTestFinished(() => reopened.close());
        expect(reopened.database.pragma('user_version', { simple: true })).toBe(
            seeded.shippedVersion,
        );
        expect(projectsTableSql(reopened)).not.toContain(ADDED_CHECK);
        expect(reopened.getProject(seeded.owner.id)).toBeDefined();
        expect(reopened.getSession(seeded.session.id)?.projectId).toBe(seeded.owner.id);
        expect(reopened.database.pragma('foreign_keys', { simple: true })).toBe(1);
    });
});

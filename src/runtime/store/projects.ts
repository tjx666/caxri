import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import type Database from 'better-sqlite3';

import type { ProjectRecord } from '../../shared/types';

interface ProjectRow {
    id: string;
    root_path: string;
    display_title: string;
    created_at: number;
    last_opened_at: number;
}

function mapProject(row: ProjectRow): ProjectRecord {
    return {
        id: row.id,
        rootPath: row.root_path,
        displayTitle: row.display_title,
        createdAt: row.created_at,
        lastOpenedAt: row.last_opened_at,
    };
}

/**
 * Pure CRUD over the `projects` table. Deletion-fallback selection and every other cross-record
 * decision live in `../../session-policy`, not here.
 */
export class ProjectsStore {
    constructor(private readonly database: Database.Database) {}

    list(): ProjectRecord[] {
        return (
            this.database
                .prepare('SELECT * FROM projects ORDER BY last_opened_at DESC, created_at ASC')
                .all() as ProjectRow[]
        ).map(mapProject);
    }

    get(id: string): ProjectRecord | undefined {
        const row = this.database.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
            ProjectRow | undefined;
        return row ? mapProject(row) : undefined;
    }

    findByRootPath(rootPath: string): ProjectRecord | undefined {
        const row = this.database
            .prepare('SELECT * FROM projects WHERE root_path = ?')
            .get(rootPath) as ProjectRow | undefined;
        return row ? mapProject(row) : undefined;
    }

    /** Idempotent by root: returns the existing Project row when one already owns `rootPath`. */
    create(rootPath: string): ProjectRecord {
        const existing = this.findByRootPath(rootPath);
        if (existing) return existing;
        const id = randomUUID();
        const now = Date.now();
        this.database
            .prepare(
                `INSERT INTO projects (id, root_path, display_title, created_at, last_opened_at)
                 VALUES (?, ?, ?, ?, ?)`,
            )
            .run(id, rootPath, basename(rootPath) || rootPath, now, now);
        return this.get(id)!;
    }

    /** Returns true when a row was removed; Sessions and Terminals cascade via foreign keys. */
    remove(id: string): boolean {
        return this.database.prepare('DELETE FROM projects WHERE id = ?').run(id).changes === 1;
    }

    /** Returns true when a row existed and was touched. */
    touchLastOpened(id: string, now = Date.now()): boolean {
        return (
            this.database
                .prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?')
                .run(now, id).changes === 1
        );
    }
}

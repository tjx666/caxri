import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import { asc, eq } from 'drizzle-orm';

import type { ProjectRecord } from '../../shared/types';
import { projects } from './schema';
import type { CaxriDrizzleDatabase } from './sqlite';

/**
 * Pure CRUD over the `projects` table. Deletion-fallback selection and every other cross-record
 * decision live in `../../session-policy`, not here.
 */
export class ProjectsStore {
    constructor(private readonly db: CaxriDrizzleDatabase) {}

    list(): ProjectRecord[] {
        return this.db
            .select()
            .from(projects)
            .orderBy(asc(projects.createdAt), asc(projects.id))
            .all();
    }

    get(id: string): ProjectRecord | undefined {
        return this.db.select().from(projects).where(eq(projects.id, id)).get();
    }

    findByRootPath(rootPath: string): ProjectRecord | undefined {
        return this.db.select().from(projects).where(eq(projects.rootPath, rootPath)).get();
    }

    /** Idempotent by root: returns the existing Project row when one already owns `rootPath`. */
    create(rootPath: string): ProjectRecord {
        const existing = this.findByRootPath(rootPath);
        if (existing) return existing;
        const id = randomUUID();
        const now = Date.now();
        this.db
            .insert(projects)
            .values({
                id,
                rootPath,
                displayTitle: basename(rootPath) || rootPath,
                createdAt: now,
                lastOpenedAt: now,
            })
            .run();
        return this.get(id)!;
    }

    /** Returns true when a row was removed; Sessions and Terminals cascade via foreign keys. */
    remove(id: string): boolean {
        return this.db.delete(projects).where(eq(projects.id, id)).run().changes === 1;
    }

    /** Returns true when a row existed and was touched. */
    touchLastOpened(id: string, now = Date.now()): boolean {
        return (
            this.db.update(projects).set({ lastOpenedAt: now }).where(eq(projects.id, id)).run()
                .changes === 1
        );
    }
}

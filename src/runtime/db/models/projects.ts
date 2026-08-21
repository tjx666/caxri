import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import { asc, eq, sql } from 'drizzle-orm';

import type { ProjectIcon } from '../../../shared/project-customization';
import { projectIconSchema } from '../../../shared/project-customization';
import type { ProjectRecord } from '../../../shared/types';
import type { CaxriDrizzleDatabase } from '../connection';
import { projects } from '../schema';

function projectRecord(row: typeof projects.$inferSelect): ProjectRecord {
    const { iconColor, iconName, ...project } = row;
    const icon = iconName
        ? projectIconSchema.parse({ name: iconName, ...(iconColor && { color: iconColor }) })
        : undefined;
    return {
        ...project,
        ...(icon && { icon }),
    };
}

/**
 * Pure CRUD over the `projects` table. Deletion-fallback selection and every other cross-record decision live in
 * `../../session-policy.ts`, not here.
 */
export class ProjectsModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    list(): ProjectRecord[] {
        return this.database
            .select()
            .from(projects)
            .orderBy(asc(projects.orderIndex), asc(projects.createdAt), asc(projects.id))
            .all()
            .map(projectRecord);
    }

    get(id: string): ProjectRecord | undefined {
        const row = this.database.select().from(projects).where(eq(projects.id, id)).get();
        return row ? projectRecord(row) : undefined;
    }

    findByRootPath(rootPath: string): ProjectRecord | undefined {
        const row = this.database
            .select()
            .from(projects)
            .where(eq(projects.rootPath, rootPath))
            .get();
        return row ? projectRecord(row) : undefined;
    }

    /**
     * Idempotent by root: returns the existing Project row when one already owns `rootPath`.
     */
    create(rootPath: string): ProjectRecord {
        const existing = this.findByRootPath(rootPath);
        if (existing) return existing;
        const id = randomUUID();
        const now = Date.now();
        const orderIndex = sql<number>`COALESCE((SELECT MAX(${projects.orderIndex}) + 1 FROM ${projects}), 0)`;
        this.database
            .insert(projects)
            .values({
                id,
                rootPath,
                displayTitle: basename(rootPath) || rootPath,
                orderIndex,
                createdAt: now,
                lastOpenedAt: now,
            })
            .run();
        return this.get(id)!;
    }

    /**
     * Writes a complete, already-validated Project order. The facade owns set validation.
     */
    reorder(projectIds: readonly string[]): void {
        for (const [orderIndex, id] of projectIds.entries())
            this.database.update(projects).set({ orderIndex }).where(eq(projects.id, id)).run();
    }

    setIcon(id: string, icon: ProjectIcon | null): boolean {
        return (
            this.database
                .update(projects)
                .set({ iconName: icon?.name ?? null, iconColor: icon?.color ?? null })
                .where(eq(projects.id, id))
                .run().changes === 1
        );
    }

    /**
     * Returns true when a row was removed; Sessions and Terminals cascade via foreign keys.
     */
    remove(id: string): boolean {
        return this.database.delete(projects).where(eq(projects.id, id)).run().changes === 1;
    }

    /**
     * Returns true when a row existed and was touched.
     */
    touchLastOpened(id: string, now = Date.now()): boolean {
        return (
            this.database
                .update(projects)
                .set({ lastOpenedAt: now })
                .where(eq(projects.id, id))
                .run().changes === 1
        );
    }
}

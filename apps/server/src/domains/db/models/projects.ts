import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import type { ProjectIcon, ProjectRecord } from '@caxri/protocol';
import { isTopLevelProject, projectIconSchema } from '@caxri/protocol';
import { asc, eq, sql } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { projects } from '../schema';

function projectRecord(row: typeof projects.$inferSelect): ProjectRecord {
    const { iconColor, iconName, ownerProjectId, ...project } = row;
    const icon = iconName
        ? projectIconSchema.parse({ name: iconName, ...(iconColor && { color: iconColor }) })
        : undefined;
    return {
        ...project,
        ...(icon && { icon }),
        ...(ownerProjectId && { ownerProjectId }),
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
     * Projects auto-registered as worktrees of `ownerProjectId`. The PrimarySidebar hides these rows, so only their
     * owner's deletion can reach them.
     */
    listOwnedBy(ownerProjectId: string): ProjectRecord[] {
        return this.database
            .select()
            .from(projects)
            .where(eq(projects.ownerProjectId, ownerProjectId))
            .orderBy(asc(projects.orderIndex), asc(projects.createdAt), asc(projects.id))
            .all()
            .map(projectRecord);
    }

    /**
     * Idempotent by root: returns the existing Project row when one already owns `rootPath`. Passing `ownerProjectId`
     * marks the row as a worktree registered automatically on that owner's behalf; omitting it is a manual add.
     *
     * Ownership is written once and only the user can clear it. An automatic registration therefore never re-owns or
     * re-points an existing row, while a manual add of a root that is currently an owned worktree clears the mark so
     * the user's explicit choice wins and the Project surfaces at the PrimarySidebar's top level.
     */
    create(rootPath: string, ownerProjectId?: string): ProjectRecord {
        const existing = this.findByRootPath(rootPath);
        if (existing) {
            if (ownerProjectId !== undefined || isTopLevelProject(existing)) return existing;
            this.database
                .update(projects)
                .set({ ownerProjectId: null })
                .where(eq(projects.id, existing.id))
                .run();
            return this.get(existing.id)!;
        }
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
                ...(ownerProjectId !== undefined && { ownerProjectId }),
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

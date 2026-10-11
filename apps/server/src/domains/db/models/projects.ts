import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import type { ProjectIcon, ProjectRecord } from '@caxri/protocol';
import { CaxriError, isTopLevelProject, projectIconSchema } from '@caxri/protocol';
import { asc, eq, sql } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { projects } from '../schema';

function projectRecord(row: typeof projects.$inferSelect): ProjectRecord {
    const { hiddenAt, iconColor, iconName, ownerProjectId, ...project } = row;
    const icon = iconName
        ? projectIconSchema.parse({ name: iconName, ...(iconColor && { color: iconColor }) })
        : undefined;
    return {
        ...project,
        ...(icon && { icon }),
        ...(ownerProjectId && { ownerProjectId }),
        ...(hiddenAt !== null && { hiddenAt }),
    };
}

/**
 * Pure CRUD over the `projects` table. Deletion-fallback selection and every other cross-record decision live in
 * `../session-policy.ts`, not here.
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
     *
     * A manual add is also what un-hides a hidden Project: the existing row, with its order, icon, and Sessions, comes
     * back instead of a fresh one. An automatic worktree registration leaves the hidden mark alone.
     */
    create(rootPath: string, ownerProjectId?: string): ProjectRecord {
        // Ownership is one level deep by construction: registering a worktree on behalf of a Project that is itself
        // an owned worktree attaches the new row to the top-level owner, so `deleteProject`'s single-level cascade can
        // never orphan a row behind a foreign-key failure.
        if (ownerProjectId !== undefined) {
            const owner = this.get(ownerProjectId);
            if (!owner) throw new CaxriError('NOT_FOUND', 'Owning Project not found');
            ownerProjectId = owner.ownerProjectId ?? owner.id;
        }
        const existing = this.findByRootPath(rootPath);
        if (existing) {
            if (
                ownerProjectId !== undefined ||
                (isTopLevelProject(existing) && existing.hiddenAt === undefined)
            )
                return existing;
            this.database
                .update(projects)
                .set({ ownerProjectId: null, hiddenAt: null })
                .where(eq(projects.id, existing.id))
                .run();
            // Hiding cascades to owned worktree Projects, so un-hiding must too: nothing else ever clears their mark,
            // and a Session whose Workbench root is one of them would stay unresolvable for file links.
            this.database
                .update(projects)
                .set({ hiddenAt: null })
                .where(eq(projects.ownerProjectId, existing.id))
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

    /**
     * Returns true when a row existed and was touched. `null` un-hides.
     */
    setHidden(id: string, hiddenAt: number | null): boolean {
        return (
            this.database.update(projects).set({ hiddenAt }).where(eq(projects.id, id)).run()
                .changes === 1
        );
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

import type { SessionRecord } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { and, isNotNull, isNull, ne } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from './connection';
import type { CaxriDatabaseConnection } from './database-connection';
import type { SessionWorkbenchBinding } from './models/sessions';
import { sessions } from './schema';

/**
 * Bindings of the unarchived Sessions that use a Project other than their owner as Workbench Root, in one query.
 * Archived Sessions are skipped: they are validated when selected, so a background sweep need not walk them.
 */
export function listActiveWorktreeBindings(
    database: CaxriDrizzleDatabase,
): Array<{ binding: SessionWorkbenchBinding; sessionId: string }> {
    return database
        .select({
            sessionId: sessions.id,
            projectId: sessions.projectId,
            workbenchRootProjectId: sessions.workbenchRootProjectId,
            rootDevice: sessions.workbenchRootDevice,
            rootInode: sessions.workbenchRootInode,
        })
        .from(sessions)
        .where(
            and(
                isNull(sessions.archivedAt),
                isNotNull(sessions.workbenchRootProjectId),
                ne(sessions.workbenchRootProjectId, sessions.projectId),
            ),
        )
        .all()
        .map((row) => ({
            sessionId: row.sessionId,
            binding: {
                projectId: row.projectId,
                workbenchRootProjectId: row.workbenchRootProjectId!,
                rootDevice: row.rootDevice ?? undefined,
                rootInode: row.rootInode ?? undefined,
            },
        }));
}

/**
 * Points a Session at another authorized Project as its Workbench Root, in one transaction with the existence checks.
 */
export function selectWorkbenchProject(
    database: CaxriDatabaseConnection,
    sessionId: string,
    projectId: string,
    identity?: { device: string; inode: string },
): SessionRecord {
    return database.transaction(() => {
        if (!database.projects.get(projectId))
            throw new CaxriError('NOT_FOUND', 'Workbench Project not found');
        if (!database.sessions.setWorkbenchProject(sessionId, projectId, identity))
            throw new CaxriError('NOT_FOUND', 'Session not found');
        return database.sessions.get(sessionId)!;
    });
}

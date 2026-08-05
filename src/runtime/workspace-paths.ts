import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { CaxriError } from '../shared/ipc/errors';
import type { CaxriDatabase } from './database';
import { assertInsideRoot } from './path-security';

export interface ResolvedSessionPath {
    root: string;
    path: string;
}

/**
 * Resolves a Session to its owning Project root and validates Session-relative paths against it.
 *
 * This is the single place that turns a Session ID plus an optional relative or absolute path into
 * a filesystem location, so `FileService` and `GitService` share one TOCTOU-safe resolution instead
 * of Git depending on the whole `FileService` just to find a Session's root.
 */
export class WorkspacePaths {
    constructor(private readonly database: CaxriDatabase) {}

    async resolveSessionPath(sessionId: string, input?: string): Promise<ResolvedSessionPath> {
        const session = this.database.getSession(sessionId);
        if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
        const root = await realpath(session.rootPath);
        const candidate = input && isAbsolute(input) ? input : resolve(root, input ?? '.');
        const resolved = await realpath(candidate);
        assertInsideRoot(relative(root, resolved), 'Symlink target is outside the Project root');
        return { root, path: resolved };
    }

    /** Returns durable Project roots that the user explicitly granted to Caxri. */
    listApprovedProjectRoots(): string[] {
        return this.database.listProjects().map((project) => project.rootPath);
    }
}

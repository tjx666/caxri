import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';

import type { ProjectRecord } from '@caxri/protocol';
import { isTopLevelProject } from '@caxri/protocol';

/**
 * The deepest visible top-level Project whose root contains `path`.
 */
function containingProject(
    projects: readonly ProjectRecord[],
    path: string,
): ProjectRecord | undefined {
    return projects
        .filter(
            (project) =>
                isTopLevelProject(project) &&
                (path === project.rootPath || path.startsWith(`${project.rootPath}${sep}`)),
        )
        .toSorted((left, right) => right.rootPath.length - left.rootPath.length)[0];
}

/**
 * The Project that contains an external conversation's folder. Provider history records the cwd as the Agent saw it,
 * which may run through a symlinked alias (macOS `/tmp` for `/private/tmp`), while Project roots are canonical; the
 * canonical folder is matched first so such a conversation lands in its existing Project instead of a nested new one. A
 * folder that no longer resolves falls back to the recorded path.
 */
export async function conversationProject(
    projects: readonly ProjectRecord[],
    cwd: string,
): Promise<ProjectRecord | undefined> {
    let canonical = cwd;
    try {
        canonical = await realpath(cwd);
    } catch {
        // A vanished folder keeps the recorded path; the import then refuses it as missing.
    }
    return containingProject(projects, canonical) ?? containingProject(projects, cwd);
}

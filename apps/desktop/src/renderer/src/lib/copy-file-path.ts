import { pushToast, tryCommand } from '../stores/toasts';
import { projectRelativePath } from './file-path';

/**
 * Base directory `Copy Relative Path` measures from when a resource has more than one candidate root, which today is
 * only the editor's Git diff tabs: a Files tree row and an ordinary editor tab both sit under the Project root by
 * construction and pass it directly.
 *
 * The Project root wins, matching VS Code's workspace-relative output and the directory a user's Terminal is usually
 * sitting in. A submodule or nested repository deliberately does not get its own base: the two menus used to disagree
 * for exactly those files, the tree reporting `packages/sub/src/a.ts` where the tab reported `src/a.ts`.
 *
 * `repoRootPath` is only a fallback for a resource with no Project-relative path at all (a Git tab opened from a linked
 * repository outside the Project), where measuring from the Project root would produce nothing to copy.
 *
 * @param absolutePath Authorized filesystem path being copied.
 * @param projectRoot Selected Workbench Project root, when one is loaded.
 * @param repoRootPath Owning repository root, for a resource that may sit outside the Project.
 */
export function relativePathRoot(
    absolutePath: string,
    projectRoot: string | undefined,
    repoRootPath?: string,
): string | undefined {
    if (projectRoot !== undefined && projectRelativePath(absolutePath, projectRoot) !== undefined)
        return projectRoot;
    return repoRootPath;
}

/**
 * Copies an authorized filesystem path and reports the same success and failure messages used by file actions.
 */
export function copyFilePath(path: string, projectRoot?: string): Promise<void | undefined> {
    return tryCommand('Unable to copy path', async () => {
        const value = projectRoot ? projectRelativePath(path, projectRoot) : path;
        if (value === undefined) throw new Error('Path is outside the selected Project');
        await navigator.clipboard.writeText(value);
        pushToast('success', projectRoot ? 'Relative path copied' : 'Path copied');
    });
}

import { projectRelativePath } from '@caxri/protocol';

import { translate } from '../i18n';
import { pushToast, tryCommand } from '../stores/toasts';
import { writeClipboardText } from './clipboard';

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
 * Copies an authorized filesystem path, or several (a Files multi-selection) one per line as VS Code does, and reports
 * the same success and failure messages used by file actions.
 */
export function copyFilePath(
    path: string | readonly string[],
    projectRoot?: string,
): Promise<void | undefined> {
    return tryCommand(translate('core.files.copyPathFailed'), async () => {
        const values = (typeof path === 'string' ? [path] : path).map((each) =>
            projectRoot ? projectRelativePath(each, projectRoot) : each,
        );
        if (values.includes(undefined)) throw new Error(translate('core.files.pathOutsideProject'));
        await writeClipboardText(values.join('\n'));
        pushToast(
            'success',
            translate(projectRoot ? 'core.files.relativePathCopied' : 'core.files.pathCopied'),
        );
    });
}

/**
 * Copies the final segment of a filesystem path, the name a user types after `@` or into a search box, and reports it
 * through the same toasts as `copyFilePath`.
 */
export function copyFileName(path: string): Promise<void | undefined> {
    return tryCommand(translate('core.files.copyPathFailed'), async () => {
        await writeClipboardText(path.slice(path.lastIndexOf('/') + 1));
        pushToast('success', translate('core.files.nameCopied'));
    });
}

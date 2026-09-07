import { pushToast, tryCommand } from '../stores/toasts';
import { projectRelativePath } from './file-path';

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

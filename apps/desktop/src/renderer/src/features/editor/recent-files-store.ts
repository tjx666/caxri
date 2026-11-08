import { environmentOfProject } from '../../lib/environment-routing';
import { createSharedLocalState } from '../../lib/local-storage';
import { storageScopeOf } from '../../stores/environment';
import { forgetRecentFile, parseRecentFiles, recordRecentFile } from './recent-files';

/**
 * Device-local storage for the recent-files history, one list per machine and Workbench Root, as VS Code keeps its
 * editor history per workspace (`StorageScope.WORKSPACE`). It is rebuildable view state, so it uses the Renderer's
 * best-effort `localStorage` rather than the device store reserved for input that cannot be rebuilt
 * (docs/client-local-data.md). The list is read and written synchronously because it is at most a few kilobytes.
 */
const STORAGE_KEY_PREFIX = 'caxri.recent-files.v1';

function storageKey(workbenchRootProjectId: string): string {
    const scope = storageScopeOf(environmentOfProject(workbenchRootProjectId));
    return `${STORAGE_KEY_PREFIX}:${scope}:${workbenchRootProjectId}`;
}

/**
 * The entry is shared by every window of the profile (docs/client-local-data.md). Each call re-reads it, never caching,
 * so a file another window opened meanwhile stays in the list; the dialog reads when it opens, so it needs no
 * subscription.
 */
function sharedRecentFiles(workbenchRootProjectId: string) {
    return createSharedLocalState(storageKey(workbenchRootProjectId), parseRecentFiles);
}

export function readRecentFiles(workbenchRootProjectId: string): string[] {
    return sharedRecentFiles(workbenchRootProjectId).read();
}

export function rememberRecentFile(workbenchRootProjectId: string, path: string): void {
    sharedRecentFiles(workbenchRootProjectId).write(
        recordRecentFile(readRecentFiles(workbenchRootProjectId), path),
    );
}

export function dropRecentFile(workbenchRootProjectId: string, path: string): void {
    sharedRecentFiles(workbenchRootProjectId).write(
        forgetRecentFile(readRecentFiles(workbenchRootProjectId), path),
    );
}

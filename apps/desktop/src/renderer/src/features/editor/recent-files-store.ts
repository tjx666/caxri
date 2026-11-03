import { environmentOfProject } from '../../lib/environment-routing';
import { readLocalStorageJson, writeLocalStorageJson } from '../../lib/local-storage';
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

export function readRecentFiles(workbenchRootProjectId: string): string[] {
    return parseRecentFiles(readLocalStorageJson(storageKey(workbenchRootProjectId)));
}

export function rememberRecentFile(workbenchRootProjectId: string, path: string): void {
    writeLocalStorageJson(
        storageKey(workbenchRootProjectId),
        recordRecentFile(readRecentFiles(workbenchRootProjectId), path),
    );
}

export function dropRecentFile(workbenchRootProjectId: string, path: string): void {
    writeLocalStorageJson(
        storageKey(workbenchRootProjectId),
        forgetRecentFile(readRecentFiles(workbenchRootProjectId), path),
    );
}

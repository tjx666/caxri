import { readLocalStorageJson, writeLocalStorageJson } from '../../lib/local-storage';
import { environmentStorageScope, useEnvironmentStore } from '../../stores/environment';
import { forgetRecentFile, parseRecentFiles, recordRecentFile } from './recent-files';

/**
 * Device-local storage for the recent-files history, one list per environment and Workbench Root, as VS Code keeps its
 * editor history per workspace (`StorageScope.WORKSPACE`). It is rebuildable view state, so it uses the Renderer's
 * best-effort `localStorage` rather than the device store reserved for input that cannot be rebuilt
 * (docs/client-local-data.md). The list is read and written synchronously because it is at most a few kilobytes.
 */
const STORAGE_KEY_PREFIX = 'caxri.recent-files.v1';

function storageKey(workbenchProjectId: string): string {
    const environment = useEnvironmentStore.getState().state;
    const scope = environment ? environmentStorageScope(environment) : 'local';
    return `${STORAGE_KEY_PREFIX}:${scope}:${workbenchProjectId}`;
}

export function readRecentFiles(workbenchProjectId: string): string[] {
    return parseRecentFiles(readLocalStorageJson(storageKey(workbenchProjectId)));
}

export function rememberRecentFile(workbenchProjectId: string, path: string): void {
    writeLocalStorageJson(
        storageKey(workbenchProjectId),
        recordRecentFile(readRecentFiles(workbenchProjectId), path),
    );
}

export function dropRecentFile(workbenchProjectId: string, path: string): void {
    writeLocalStorageJson(
        storageKey(workbenchProjectId),
        forgetRecentFile(readRecentFiles(workbenchProjectId), path),
    );
}

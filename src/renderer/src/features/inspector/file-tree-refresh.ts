import type { FileChange } from '@shared/types';

export interface FileTreeChangeRevisions {
    directories: Record<string, number>;
    overflow: number;
    sessionId?: string;
}

/** Returns the directory whose listing directly owns a changed absolute path. */
export function parentDirectoryPath(path: string): string {
    const separator = path.lastIndexOf('/');
    if (separator < 0) return '';
    return separator === 0 ? '/' : path.slice(0, separator);
}

/** Advances only directly affected directory revisions; overflow invalidates every visible list. */
export function updateFileTreeChangeRevisions(
    previous: FileTreeChangeRevisions,
    payload: { changes: FileChange[]; overflow: boolean; sessionId: string },
): FileTreeChangeRevisions {
    const current =
        previous.sessionId === payload.sessionId ? previous : { directories: {}, overflow: 0 };
    if (payload.overflow)
        return {
            ...current,
            overflow: current.overflow + 1,
            sessionId: payload.sessionId,
        };
    const directories = { ...current.directories };
    for (const change of payload.changes) {
        const parent = parentDirectoryPath(change.path);
        directories[parent] = (directories[parent] ?? 0) + 1;
    }
    return { ...current, directories, sessionId: payload.sessionId };
}

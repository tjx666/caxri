import type { MethodResult } from '@shared/ipc';
import type { MutableFileEntry } from '@shared/types';

import { caxri } from '../../../../lib/caxri';
import { caxriQueryKey, queryClient } from '../../../../queries/client';
import { getSelectedSession } from '../../../../stores/selectors';
import { tryCommand } from '../../../../stores/toasts';
import {
    closeOpenEditorsUnderPath,
    openFile,
    remapOpenEditors,
} from '../../../editor/document-actions';
import { parentDirectoryPath } from './file-tree-refresh';

function invalidateDirectory(sessionId: string, directory: string): Promise<void> {
    return queryClient.invalidateQueries({
        queryKey: caxriQueryKey('files.list', { sessionId, directory }),
    });
}

export async function createFile(
    sessionId: string,
    directory: string,
    name: string,
): Promise<MutableFileEntry> {
    const created = await caxri.request('files.create', { sessionId, directory, name });
    await invalidateDirectory(sessionId, directory);
    if (getSelectedSession()?.id === sessionId) void openFile(created.path);
    return created;
}

export async function renameFile(
    sessionId: string,
    path: string,
    name: string,
): Promise<MethodResult<'files.rename'>> {
    const moved = await caxri.request('files.rename', { sessionId, path, name });
    remapOpenEditors(sessionId, moved.previousPath, moved.path);
    await invalidateDirectory(sessionId, parentDirectoryPath(moved.previousPath));
    return moved;
}

export function moveFile(
    sessionId: string,
    path: string,
    directory: string,
): Promise<MethodResult<'files.move'> | undefined> {
    return tryCommand('Unable to move item', async () => {
        const moved = await caxri.request('files.move', { sessionId, path, directory });
        remapOpenEditors(sessionId, moved.previousPath, moved.path);
        await Promise.all([
            invalidateDirectory(sessionId, parentDirectoryPath(moved.previousPath)),
            invalidateDirectory(sessionId, directory),
        ]);
        return moved;
    });
}

export async function trashFile(sessionId: string, path: string): Promise<boolean> {
    const result = await tryCommand('Unable to move item to Trash', () =>
        caxri.request('files.trash', { sessionId, path }),
    );
    if (!result || 'canceled' in result) return false;
    closeOpenEditorsUnderPath(sessionId, result.path);
    await invalidateDirectory(sessionId, parentDirectoryPath(result.path));
    return true;
}

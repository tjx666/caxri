import type { ServerOperationResult } from '@caxri/protocol';

import type { DesktopServerConnection } from '../server-connection';
import { trashLocalItem } from './local-item';

/**
 * Moves an item the user confirmed and Server re-authorized into the Trash, and returns the Undo receipt when the move
 * reported where the item landed.
 *
 * An SSH Host's entry lives on the remote machine, so its own Server moves it into that host's Trash; Electron's Trash
 * API would act on this Mac. The approved identity is repeated so Server refuses a path replaced after the dialog.
 */
export async function moveAuthorizedItemToTrash(
    supervisor: Pick<DesktopServerConnection, 'request'>,
    sessionId: string,
    current: ServerOperationResult<'files.authorizeTrash'>,
    isRemoteHost: boolean,
): Promise<{ undoToken?: string }> {
    if (isRemoteHost) {
        const { undoToken } = await supervisor.request('files.trashOnHost', {
            sessionId,
            path: current.path,
            device: current.device,
            inode: current.inode,
        });
        return { undoToken };
    }
    const trashPath = await trashLocalItem(current.path);
    if (!trashPath) return {};
    /**
     * The item is already in the Trash, so a failure to record where only costs the Undo offer and must not turn a
     * successful move into an error.
     */
    try {
        const { undoToken } = await supervisor.request('files.recordTrash', {
            sessionId,
            path: current.path,
            trashPath,
            device: current.device,
            inode: current.inode,
        });
        return undoToken ? { undoToken } : {};
    } catch {
        return {};
    }
}

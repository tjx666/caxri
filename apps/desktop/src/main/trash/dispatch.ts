import type { MethodResult, ServerOperationResult } from '@caxri/protocol';
import { CaxriError, isPathAtOrBelow } from '@caxri/protocol';

import type { DesktopServerConnection } from '../connection/server-connection';
import { trashLocalItem } from './local-item';

type AuthorizedTrashItem = ServerOperationResult<'files.authorizeTrash'>;
type TrashedItems = Extract<MethodResult<'files.trash'>, { items: unknown }>['items'];

/**
 * Moves an item the user confirmed and Server re-authorized into the Trash, and returns the Undo receipt when the move
 * reported where the item landed.
 *
 * An SSH Host's entry lives on the remote machine, so its own Server moves it into that host's Trash; Electron's Trash
 * API would act on this Mac. The approved identity is repeated so Server refuses a path replaced after the dialog.
 */
async function moveAuthorizedItemToTrash(
    supervisor: Pick<DesktopServerConnection, 'request'>,
    sessionId: string,
    current: AuthorizedTrashItem,
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

function isSameAuthorizedItem(left: AuthorizedTrashItem, right: AuthorizedTrashItem): boolean {
    return (
        left.path === right.path &&
        left.device === right.device &&
        left.inode === right.inode &&
        left.root.path === right.root.path &&
        left.root.device === right.root.device &&
        left.root.inode === right.root.inode
    );
}

/**
 * The whole `files.trash` flow: every entry is authorized before the one confirmation, so a path the Session may not
 * touch fails the request before anything is asked or moved. After the user confirms, each entry is reauthorized
 * immediately before its own move, so a path replaced while the dialog was open cannot inherit approval.
 *
 * Entries move one at a time and the batch stops at the first failure. Every earlier move is already done by then, so
 * the result reports what reached the Trash (for editor cleanup and Undo) next to the failure instead of discarding it
 * behind an error.
 */
export async function trashConfirmedItems(
    supervisor: Pick<DesktopServerConnection, 'request'>,
    parameters: { sessionId: string; paths: readonly string[] },
    options: {
        confirm: (items: readonly AuthorizedTrashItem[]) => Promise<boolean>;
        isRemoteHost: boolean;
    },
): Promise<MethodResult<'files.trash'>> {
    const { sessionId } = parameters;
    /**
     * A folder takes its contents to the Trash, so a listed entry inside another listed folder (or a duplicate) would
     * only fail its second authorization after the folder moved and turn a clean batch into a partial one.
     */
    const paths = [...new Set(parameters.paths)].filter((path, _index, all) =>
        all.every((other) => other === path || !isPathAtOrBelow(path, other)),
    );
    const approved: AuthorizedTrashItem[] = [];
    for (const path of paths)
        // One Server round trip per entry, in selection order.
        // eslint-disable-next-line no-await-in-loop -- see above
        approved.push(await supervisor.request('files.authorizeTrash', { sessionId, path }));
    if (!(await options.confirm(approved))) return { canceled: true };
    const items: TrashedItems = [];
    for (const item of approved) {
        try {
            // Sequential on purpose: the batch stops at the first failure (see above).
            // eslint-disable-next-line no-await-in-loop -- see above
            const current = await supervisor.request('files.authorizeTrash', {
                sessionId,
                path: item.path,
            });
            if (!isSameAuthorizedItem(current, item))
                throw new CaxriError('CONFLICT', 'File or folder changed before it reached Trash');
            // eslint-disable-next-line no-await-in-loop -- see above
            const receipt = await moveAuthorizedItemToTrash(
                supervisor,
                sessionId,
                current,
                options.isRemoteHost,
            );
            items.push({ kind: item.kind, name: item.name, path: item.path, ...receipt });
        } catch (error) {
            /**
             * A failure on the first entry has moved nothing, so it stays the request's own error, exactly as a
             * single-entry Trash always reported it; only a partly applied batch needs the structured report.
             */
            if (items.length === 0) throw error;
            return {
                items,
                failure: {
                    path: item.path,
                    message: error instanceof Error ? error.message : String(error),
                },
            };
        }
    }
    return { items };
}

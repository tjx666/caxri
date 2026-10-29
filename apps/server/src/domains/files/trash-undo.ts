import type { BigIntStats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { ServerOperationParameters, ServerOperationResult } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { ProjectRootResolver } from '../project';
import { moveToHostTrash } from './host-trash';
import type { FileOperationQueue } from './operation-queue';
import { isReceiptEntryPresent, restoreFromTrash, TrashReceipts } from './trash-receipts';

type AuthorizeTrash = (
    parameters: ServerOperationParameters<'files.authorizeTrash'>,
) => Promise<ServerOperationResult<'files.authorizeTrash'>>;

/**
 * Moves into the host Trash and back out of it, for the Files tree's Undo.
 *
 * A receipt is only ever created from a location the move itself reported (`moveToHostTrash`'s return value, or the
 * path Main's native call printed and this class re-verified by filesystem identity), so Undo never searches the
 * Trash.
 */
export class TrashUndo {
    private readonly receipts = new TrashReceipts();

    constructor(
        private readonly projectRoots: ProjectRootResolver,
        private readonly operations: FileOperationQueue,
        private readonly authorizeTrash: AuthorizeTrash,
    ) {}

    async trashOnHost(
        parameters: ServerOperationParameters<'files.trashOnHost'>,
    ): Promise<ServerOperationResult<'files.trashOnHost'>> {
        const { path } = await this.projectRoots.resolveSessionPath(
            parameters.sessionId,
            parameters.path,
        );
        return this.operations.run(
            async () => {
                const entry = await this.authorizeTrash(parameters);
                if (entry.device !== parameters.device || entry.inode !== parameters.inode)
                    throw new CaxriError(
                        'CONFLICT',
                        'File or folder changed before it reached Trash',
                    );
                const trashPath = await moveToHostTrash(entry.path);
                /**
                 * Identity is read after the move: a copy across filesystems gives the Trash entry a new inode, so the
                 * identity the user approved cannot vouch for it.
                 */
                const stats = await lstat(trashPath, { bigint: true });
                return {
                    undoToken: this.receipts.add({
                        sessionId: parameters.sessionId,
                        originalPath: entry.path,
                        trashPath,
                        device: stats.dev,
                        inode: stats.ino,
                    }),
                };
            },
            { paths: [path] },
        );
    }

    /**
     * Records where Main's native Trash call put an item. The location is trusted only when the entry there carries the
     * identity the user approved, so a mis-reported location yields no Undo rather than moving the wrong item.
     */
    async recordTrash(
        parameters: ServerOperationParameters<'files.recordTrash'>,
    ): Promise<ServerOperationResult<'files.recordTrash'>> {
        /**
         * The original path no longer exists, so authorization covers the folder it lived in, which must still sit
         * inside the Session's Project root.
         */
        await this.projectRoots.resolveSessionPath(parameters.sessionId, dirname(parameters.path));
        let stats: BigIntStats;
        try {
            stats = await lstat(parameters.trashPath, { bigint: true });
        } catch {
            return { undoToken: null };
        }
        if (stats.dev.toString() !== parameters.device || stats.ino.toString() !== parameters.inode)
            return { undoToken: null };
        return {
            undoToken: this.receipts.add({
                sessionId: parameters.sessionId,
                originalPath: parameters.path,
                trashPath: parameters.trashPath,
                device: stats.dev,
                inode: stats.ino,
            }),
        };
    }

    /**
     * Moves a trashed item back to where it was, refusing to replace anything that now occupies that path.
     */
    async restoreTrashed(
        parameters: ServerOperationParameters<'files.restoreTrashed'>,
    ): Promise<ServerOperationResult<'files.restoreTrashed'>> {
        const receipt = this.receipts.get(parameters.undoToken);
        if (!receipt || receipt.sessionId !== parameters.sessionId)
            throw new CaxriError('NOT_FOUND', 'This Undo is no longer available');
        const name = basename(receipt.originalPath);
        const folder = await this.projectRoots.resolveSessionPath(
            parameters.sessionId,
            dirname(receipt.originalPath),
        );
        const target = join(folder.path, name);
        return this.operations.run(
            async () => {
                if (!(await isReceiptEntryPresent(receipt)))
                    throw new CaxriError('NOT_FOUND', `${name} is no longer in the Trash`);
                const isDirectory = (await lstat(receipt.trashPath)).isDirectory();
                await restoreFromTrash(receipt, target, isDirectory);
                this.receipts.delete(parameters.undoToken);
                return { kind: isDirectory ? 'directory' : 'file', name, path: target };
            },
            { paths: [target] },
        );
    }
}

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { CaxriError } from '@caxri/protocol';

/**
 * Enough recent Trash moves to undo a short burst of deletions, few enough that the memory-only map stays trivial.
 */
const MAXIMUM_RECEIPTS = 20;

/**
 * What Server remembers about one item it was told reached the Trash.
 */
export interface TrashReceipt {
    sessionId: string;
    /**
     * Where the item lived, canonical at the time it was trashed.
     */
    originalPath: string;
    /**
     * The exact location of the item inside the Trash, reported by the move itself and never guessed.
     */
    trashPath: string;
    device: bigint;
    inode: bigint;
}

function isErrorCode(error: unknown, code: string): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

/**
 * Bounded, memory-only record of recent Trash moves, so Undo can find an item again without scanning the Trash.
 *
 * Memory-only on purpose: a receipt that outlived the Server could point at a Trash entry that was emptied and reused
 * since, and the filesystem identity check below only holds while the session that made the receipt is still the one
 * asking. After a restart the item is still in the Trash and Finder's Put Back remains the way out.
 */
export class TrashReceipts {
    private readonly receipts = new Map<string, TrashReceipt>();

    add(receipt: TrashReceipt): string {
        const token = randomUUID();
        this.receipts.set(token, receipt);
        for (const oldest of this.receipts.keys()) {
            if (this.receipts.size <= MAXIMUM_RECEIPTS) break;
            this.receipts.delete(oldest);
        }
        return token;
    }

    get(token: string): TrashReceipt | undefined {
        return this.receipts.get(token);
    }

    delete(token: string): void {
        this.receipts.delete(token);
    }
}

/**
 * Whether the entry at `path` is the one `receipt` describes: a rename keeps the inode, so a different identity means
 * the Trash entry was emptied, replaced, or moved by someone else in the meantime.
 */
export async function isReceiptEntryPresent(receipt: TrashReceipt): Promise<boolean> {
    try {
        const stats = await lstat(receipt.trashPath, { bigint: true });
        return stats.dev === receipt.device && stats.ino === receipt.inode;
    } catch (error) {
        if (isErrorCode(error, 'ENOENT')) return false;
        throw error;
    }
}

/**
 * Moves the trashed item back to `target` without ever replacing something that exists there.
 *
 * `rename` silently replaces a file or an empty folder, so the target name is first claimed with an exclusive
 * placeholder of the same kind (the mechanism `host-trash.ts` uses in the other direction). The claim fails with
 * `EEXIST` if anything, including an item created a moment ago, holds the name, and the `rename` then replaces only the
 * placeholder this call created.
 */
export async function restoreFromTrash(
    receipt: TrashReceipt,
    target: string,
    isDirectory: boolean,
): Promise<void> {
    try {
        if (isDirectory) await mkdir(target, { mode: 0o700 });
        else await writeFile(target, '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
        if (isErrorCode(error, 'EEXIST'))
            throw new CaxriError('CONFLICT', `${basename(target)} already exists at its old place`);
        throw error;
    }
    try {
        await rename(receipt.trashPath, target);
    } catch (error) {
        await (isDirectory ? rmdir(target) : rm(target, { force: true }));
        if (isErrorCode(error, 'EXDEV'))
            throw new CaxriError('IO', 'The item is on another volume than its old place');
        throw error;
    }
    await removeFreedesktopInfo(receipt.trashPath);
}

/**
 * A freedesktop.org Trash entry has a `.trashinfo` beside it that Trash viewers list, and a restored item must not
 * leave one behind pointing at nothing. No effect for macOS, whose Trash has no such index.
 */
async function removeFreedesktopInfo(trashPath: string): Promise<void> {
    const filesDirectory = dirname(trashPath);
    if (basename(filesDirectory) !== 'files') return;
    await rm(join(dirname(filesDirectory), 'info', `${basename(trashPath)}.trashinfo`), {
        force: true,
    });
}

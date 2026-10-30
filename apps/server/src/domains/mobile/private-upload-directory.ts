import { chmod, lstat, mkdir } from 'node:fs/promises';
import { userInfo } from 'node:os';

import { CaxriError } from '@caxri/protocol';

/**
 * Creates `root` when missing and proves it is a private directory of this account before anything is written there. A
 * planted symlink or foreign directory would expose a phone's uploads to another account, which matters because on
 * Linux `tmpdir()` is the shared `/tmp`.
 */
export async function ensurePrivateUploadDirectory(root: string): Promise<void> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== userInfo().uid)
        throw new CaxriError('CONFLICT', 'The mobile upload directory is not owned by you.');
    await chmod(root, 0o700);
}

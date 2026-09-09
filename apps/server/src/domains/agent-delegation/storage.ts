import type { Stats } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { CaxriError } from '@caxri/protocol';

/**
 * Removes only database-owned opaque task directories. A replaced storage root must never redirect recursive cleanup
 * outside the profile; an individual replaced directory is unlinked without following its symlink.
 */
export async function removeDelegationFiles(userDataPath: string, ids: readonly string[]) {
    if (ids.length === 0) return;
    const root = join(userDataPath, 'delegations');
    let info: Stats;
    try {
        info = await lstat(root);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
        throw new CaxriError('FORBIDDEN', 'Delegation storage must be a private directory');
    for (const id of ids) {
        if (!/^(?:[\da-f-]{36}|dispatch-[\da-f]{64})$/u.test(id))
            throw new CaxriError('VALIDATION', 'Delegation cleanup requires generated identifiers');
    }
    await Promise.all(ids.map((id) => rm(join(root, id), { recursive: true, force: true })));
}

import { isCaxriError } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';

/**
 * Whether a closed Project file still exists to reopen. Only a missing file is ruled out: `files.resolveKind` also
 * refuses a hard-linked dependency file that `files.read` still opens, so any other refusal is left to the open
 * itself.
 */
export async function isReopenableFile(sessionId: string, path: string): Promise<boolean> {
    try {
        return (await caxri.request('files.resolveKind', { sessionId, path })) === 'file';
    } catch (error) {
        return !(isCaxriError(error) && error.code === 'NOT_FOUND');
    }
}

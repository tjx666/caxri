import type { FileEntry } from '@caxri/protocol';

import { parentDirectoryPath } from '../../../../lib/file-path';

/**
 * The directory a drag dropped on a Files tree row lands in. A directory row takes the drop itself; a file row takes it
 * into its parent directory, the same target Paste on that row uses. A symlink row is not a drop target, and the drop
 * falls through to the tree container's Project root target.
 */
export function fileTreeDropDirectory(entry: FileEntry): string | undefined {
    if (entry.kind === 'directory') return entry.path;
    if (entry.kind === 'file') return parentDirectoryPath(entry.path);
    return undefined;
}

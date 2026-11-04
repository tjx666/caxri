import { CaxriError } from '@caxri/protocol';
import { readBoundedRegularFileText } from '@caxri/system';

/**
 * Reads a long text argument (a delegation task, an Inbox report) from a file, because a single argv entry is capped
 * far below what these carry. Refuses a symlink (`O_NOFOLLOW`) and anything but a regular file, never blocks on a FIFO
 * (the shared reader opens `O_NONBLOCK`), and reads one byte past the limit so a file that grew after `stat` is still
 * rejected instead of silently truncated.
 */
export async function readBoundedTextFile(
    path: string,
    maxBytes: number,
    label: string,
): Promise<string> {
    const limit = `${maxBytes / 1_024} KiB`;
    try {
        return await readBoundedRegularFileText(path, maxBytes, { symlinks: 'nofollow' });
    } catch (error) {
        if (
            (error instanceof CaxriError && (error.code === 'CAPACITY' || error.code === 'IO')) ||
            isFileShapeError(error)
        )
            throw new CaxriError(
                'VALIDATION',
                `${label} must be a regular file of at most ${limit}`,
            );
        if (isMissingFileError(error)) throw new CaxriError('VALIDATION', `${label} was not found`);
        throw error;
    }
}

/**
 * The shared reader lets filesystem faults through unchanged; a symlink or a directory is a bad argument, not a crash.
 */
function isFileShapeError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ELOOP' || code === 'EISDIR';
}

function isMissingFileError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
}

import type { Buffer } from 'node:buffer';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { AsyncSemaphore } from '@caxri/system';

import { readBoundedRegularFile } from '../bounded-file-reader';

/**
 * One descriptor budget for every working-tree file Git consumers read directly — mobile Changes patches and the
 * sidebar's untracked line counts — so neither can starve the other or the process of file descriptors.
 */
const workingFileReads = new AsyncSemaphore(8);

/**
 * Reads a working-tree file up to `maxBytes`, or `null` when the path is not a regular file. A file over the cap
 * rejects, the same as {@link readBoundedRegularFile}.
 */
export async function readWorkingFile(path: string, maxBytes: number): Promise<Buffer | null> {
    return workingFileReads.run(async () => {
        if (!(await lstat(path)).isFile()) return null;
        return readBoundedRegularFile(path, maxBytes);
    });
}

export function lineCount(content: Buffer): number {
    if (content.length === 0) return 0;
    let count = content.at(-1) === 10 ? 0 : 1;
    for (const byte of content) if (byte === 10) count += 1;
    return count;
}

/**
 * Lines an untracked file adds, which `git diff` never reports because the file has no index entry. A binary, moving,
 * or over-cap file counts as zero rather than failing the whole count.
 */
export async function untrackedLineCount(
    rootPath: string,
    path: string,
    maxBytes: number,
): Promise<number> {
    try {
        const content = await readWorkingFile(resolve(rootPath, path), maxBytes);
        return !content || content.includes(0) ? 0 : lineCount(content);
    } catch {
        return 0;
    }
}

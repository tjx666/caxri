import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import type { MethodResult } from '@caxri/protocol';
import { CaxriError, MAX_CONFIGURABLE_FILE_BYTES } from '@caxri/protocol';

import { rememberExternalDocument } from './external-documents';
import type { EntrySnapshot, RootIdentity } from './path-browser-identity';
import {
    authorizeCandidate,
    directoryIdentity,
    pathFailure,
    validateDirectory,
} from './path-browser-identity';

export type ExternalEditorDocument = Extract<
    MethodResult<'pathBrowser.open'>,
    { kind: 'external' }
>['document'];

interface BoundedFileReader {
    read(
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
    ): Promise<{ bytesRead: number }>;
}

/**
 * Reads at most one byte beyond the external-file limit. A file can grow after `stat()`, so `readFile()` would allow
 * another process to make Main allocate the entire expanded file before a post-read check could reject it.
 */
export async function readBoundedExternalContent(file: BoundedFileReader): Promise<Buffer> {
    const content = Buffer.allocUnsafe(MAX_CONFIGURABLE_FILE_BYTES + 1);
    let offset = 0;
    while (offset < content.byteLength) {
        // eslint-disable-next-line no-await-in-loop -- one bounded file descriptor owns a sequential cursor
        const { bytesRead } = await file.read(content, offset, content.byteLength - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
    }
    if (offset > MAX_CONFIGURABLE_FILE_BYTES)
        throw new CaxriError('CAPACITY', 'File exceeded the read safety limit');
    return content.subarray(0, offset);
}

/**
 * Reads one bounded snapshot of a file the user explicitly chose outside every Project (a Terminal link or free-path
 * browser entry) and registers it so later saves and desktop actions can name it by ID. The parent directory is
 * revalidated around the read and the path may not traverse a symbolic link, so a confirmed path cannot be redirected
 * before Main opens it.
 */
export async function readExternalFileSnapshot(path: string): Promise<ExternalEditorDocument> {
    if (!isAbsolute(path))
        throw new CaxriError('VALIDATION', 'External file path must be absolute');
    /**
     * The containing directory is canonicalized before it is identified, because a perfectly ordinary external path can
     * reach it through a symlinked ancestor: on macOS `/tmp` is a link to `/private/tmp`, so every `/tmp/...` Terminal
     * link used to be refused as "not a directory" even though the file was there. Only the ancestors are resolved; the
     * final segment stays lexical, so `authorizeCandidate` still sees a symlinked _file_ as one and refuses it.
     */
    const parentPath = await realpathExisting(dirname(path));
    const name = basename(path);
    const parent = await directoryIdentity(parentPath);
    return readExternalFile(parent, resolve(parentPath, name), name);
}

async function realpathExisting(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch (error) {
        return pathFailure(error, 'Unable to inspect external file location');
    }
}

export async function readExternalFile(
    parent: RootIdentity,
    path: string,
    name: string,
    expected?: EntrySnapshot,
): Promise<ExternalEditorDocument> {
    const authorized = await authorizeCandidate(parent, path, expected);
    if (authorized.kind !== 'file')
        throw new CaxriError('VALIDATION', 'Path is not a regular file');
    let file: Awaited<ReturnType<typeof open>>;
    try {
        file = await open(authorized.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
        return pathFailure(error, 'Unable to open external file');
    }
    try {
        const opened = await file.stat({ bigint: true });
        if (
            !opened.isFile() ||
            opened.dev.toString() !== authorized.identity.device ||
            opened.ino.toString() !== authorized.identity.inode
        )
            throw new CaxriError('CONFLICT', 'File changed before it was opened');
        if (opened.nlink > 1n)
            throw new CaxriError(
                'PATH_DENIED',
                'Files with multiple filesystem links cannot be opened',
            );
        if (opened.size > BigInt(MAX_CONFIGURABLE_FILE_BYTES))
            throw new CaxriError(
                'CAPACITY',
                `File exceeds the ${MAX_CONFIGURABLE_FILE_BYTES} byte safety limit`,
            );
        const boundedContent = await readBoundedExternalContent(file);
        if (boundedContent.includes(0))
            throw new CaxriError('IO', 'Binary files cannot be opened in the editor');
        const current = await lstat(authorized.path, { bigint: true });
        if (
            current.isSymbolicLink() ||
            !current.isFile() ||
            current.dev !== opened.dev ||
            current.ino !== opened.ino ||
            current.nlink > 1n ||
            (await realpath(authorized.path)) !== authorized.path
        )
            throw new CaxriError('CONFLICT', 'File changed while it was opened');
        await validateDirectory(parent);
        const id = rememberExternalDocument({ parent, path: authorized.path });
        return {
            id,
            name,
            displayPath: authorized.path,
            content: boundedContent.toString('utf8'),
            mtimeMs: Number(opened.mtimeMs),
            size: Number(opened.size),
        };
    } catch (error) {
        return pathFailure(error, 'Unable to read external file');
    } finally {
        await file.close();
    }
}

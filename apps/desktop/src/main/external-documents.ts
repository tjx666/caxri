import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { MethodResult } from '@caxri/protocol';
import { CaxriError, MAX_CONFIGURABLE_FILE_BYTES } from '@caxri/protocol';

import type { RootIdentity } from './path-browser-identity';
import { authorizeCandidate, pathFailure, validateDirectory } from './path-browser-identity';

/**
 * Bounds the registry the way the Renderer bounds its cache of external documents; the oldest entries go first. An
 * evicted document keeps its open tab, but desktop actions and saves on it fail until the file is opened again.
 */
const MAX_EXTERNAL_DOCUMENTS = 512;

interface ExternalDocumentTarget {
    parent: RootIdentity;
    path: string;
}

/**
 * Every external document Main read in this process lifetime, keyed by the opaque `documentId` the Renderer holds.
 *
 * This is the whole authority behind writing and the desktop actions: the Renderer can name only an ID Main issued
 * after the user explicitly opened that file, never a path. The map is process-scoped on purpose, matching the
 * Renderer's ephemeral tabs, which are never restored across a restart.
 */
const documents = new Map<string, ExternalDocumentTarget>();

/**
 * Registers a file Main just read and returns its ID. Reopening a path keeps the ID it already had: the Renderer finds
 * an open tab by that ID, so a fresh one would leave the reopened tab pointing at an ID that may have been evicted.
 * Reading and saving both move the entry to the newest end of the eviction order.
 */
export function rememberExternalDocument(target: ExternalDocumentTarget): string {
    const documentId =
        [...documents].find(([, existing]) => existing.path === target.path)?.[0] ?? randomUUID();
    touch(documentId, target);
    return documentId;
}

function touch(documentId: string, target: ExternalDocumentTarget): void {
    documents.delete(documentId);
    documents.set(documentId, target);
    while (documents.size > MAX_EXTERNAL_DOCUMENTS)
        documents.delete(documents.keys().next().value!);
}

/**
 * Resolves an ID to the file it was read from, reauthorizing the path first: the parent folder must still be the one
 * that was read and the entry must still be a regular file that is not a symbolic link.
 *
 * The file's own identity is deliberately not pinned. Many editors save by writing a new file and renaming it over the
 * old one, so the inode at a path changes on every save from another app, and the path the user opened is the
 * document's identity, exactly as for a Project file.
 */
async function authorizedTarget(documentId: string) {
    const target = documents.get(documentId);
    if (!target)
        throw new CaxriError(
            'NOT_FOUND',
            'This document is no longer available. Open the file again.',
        );
    const authorized = await authorizeCandidate(target.parent, target.path);
    if (authorized.kind !== 'file')
        throw new CaxriError('VALIDATION', 'Path is not a regular file');
    touch(documentId, target);
    return authorized;
}

export async function externalDocumentPath(documentId: string): Promise<string> {
    return (await authorizedTarget(documentId)).path;
}

export async function externalDocumentDirectory(documentId: string): Promise<string> {
    return dirname(await externalDocumentPath(documentId));
}

/**
 * Overwrites the file in place, so its inode, permissions, and extended attributes survive the save. The tradeoff is
 * that the write is not atomic: a crash mid-save can leave the file truncated, as with any in-place editor save.
 * `O_NOFOLLOW` plus the post-open identity check close the window between authorizing the path and opening it, so a
 * link swapped in after authorization cannot redirect the write; `O_NONBLOCK` keeps a FIFO swapped in at the path from
 * blocking the open, and the identity check then refuses it.
 */
export async function writeExternalDocument(
    documentId: string,
    content: string,
): Promise<MethodResult<'externalDocument.write'>> {
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.byteLength > MAX_CONFIGURABLE_FILE_BYTES)
        throw new CaxriError(
            'CAPACITY',
            `File exceeds the ${MAX_CONFIGURABLE_FILE_BYTES} byte safety limit`,
        );
    const authorized = await authorizedTarget(documentId);
    let file: Awaited<ReturnType<typeof open>>;
    try {
        file = await open(
            authorized.path,
            constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
    } catch (error) {
        return pathFailure(error, 'Unable to open external file for writing');
    }
    try {
        const opened = await file.stat({ bigint: true });
        if (
            !opened.isFile() ||
            opened.dev.toString() !== authorized.identity.device ||
            opened.ino.toString() !== authorized.identity.inode
        )
            throw new CaxriError('CONFLICT', 'File changed before it was saved');
        if (opened.nlink > 1n)
            throw new CaxriError(
                'PATH_DENIED',
                'Files with multiple filesystem links cannot be saved',
            );
        await file.truncate(0);
        let offset = 0;
        while (offset < bytes.byteLength) {
            // eslint-disable-next-line no-await-in-loop -- one file descriptor owns a sequential cursor
            const { bytesWritten } = await file.write(
                bytes,
                offset,
                bytes.byteLength - offset,
                offset,
            );
            offset += bytesWritten;
        }
        await file.sync();
        const written = await file.stat();
        if ((await realpath(authorized.path)) !== authorized.path)
            throw new CaxriError('CONFLICT', 'File changed while it was saved');
        await validateDirectory(authorized.identity.root);
        return { content, mtimeMs: written.mtimeMs, size: written.size };
    } catch (error) {
        return pathFailure(error, 'Unable to save external file');
    } finally {
        await file.close();
    }
}

/**
 * Test-only reset; Main's registry otherwise lives for the whole process.
 */
export function clearExternalDocumentsForTesting(): void {
    documents.clear();
}

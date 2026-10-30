import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { MethodResult } from '@caxri/protocol';
import { CaxriError, MAX_CONFIGURABLE_FILE_BYTES } from '@caxri/protocol';

import type { RootIdentity } from '../path-browser/identity';
import { authorizeCandidate, pathFailure, validateDirectory } from '../path-browser/identity';
import { EXTERNAL_FILE_SIZE_LIMIT_LABEL } from './limits';

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
 * The file's size and modification time as Main last read or wrote it, in the representation both report to the
 * Renderer (whole milliseconds from a `bigint` stat), so a change notice compares like with like.
 */
export interface ExternalDocumentState {
    mtimeMs: number;
    size: number;
}

interface ExternalDocumentEntry extends ExternalDocumentTarget {
    known?: ExternalDocumentState;
    /**
     * Saves in flight. The watcher holds its verdict until they finish, because a half-written file is neither the old
     * state nor the one the save will record.
     */
    writes: number;
}

/**
 * Every external document Main read in this process lifetime, keyed by the opaque `documentId` the Renderer holds.
 *
 * This is the whole authority behind writing and the desktop actions: the Renderer can name only an ID Main issued
 * after the user explicitly opened that file, never a path. The map is process-scoped on purpose, matching the
 * Renderer's ephemeral tabs, which are never restored across a restart.
 */
const documents = new Map<string, ExternalDocumentEntry>();

/**
 * Registers a file Main just read and returns its ID. Reopening a path keeps the ID it already had: the Renderer finds
 * an open tab by that ID, so a fresh one would leave the reopened tab pointing at an ID that may have been evicted.
 * Reading and saving both move the entry to the newest end of the eviction order.
 */
export function rememberExternalDocument(
    target: ExternalDocumentTarget,
    known: ExternalDocumentState,
): string {
    const [documentId, existing] = [...documents].find(
        ([, entry]) => entry.path === target.path,
    ) ?? [randomUUID(), undefined];
    // Updated in place: a save in flight holds this entry and settles its `writes` count on it.
    touch(documentId, Object.assign(existing ?? { writes: 0 }, target, { known }));
    return documentId;
}

function touch(documentId: string, target: ExternalDocumentEntry): void {
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
    return { ...authorized, parent: target.parent };
}

/**
 * The reauthorized file behind an ID together with the folder identity it was read under.
 */
export function authorizedExternalDocument(documentId: string) {
    return authorizedTarget(documentId);
}

/**
 * Whether a Caxri save is still writing this document. The save truncates before it writes, so a read in that window
 * would see a partial file.
 */
export function isExternalDocumentWriting(documentId: string): boolean {
    return (documents.get(documentId)?.writes ?? 0) > 0;
}

/**
 * The path a registered document was read from, without touching the filesystem; the watcher only needs to know which
 * folder to observe, and every read it triggers is reauthorized.
 */
export function externalDocumentWatchPath(documentId: string): string | undefined {
    return documents.get(documentId)?.path;
}

/**
 * Whether the file on disk still matches what Main last read or wrote for this document. `busy` while a save is still
 * writing it. A file that is gone or no longer a regular file reads as `unchanged`: there is nothing to reload, and a
 * file written back in its place is reported by the watcher's next event.
 */
export async function externalDocumentDiskState(
    documentId: string,
): Promise<'busy' | 'changed' | 'unchanged'> {
    const entry = documents.get(documentId);
    if (!entry) return 'unchanged';
    if (entry.writes > 0) return 'busy';
    let current: BigIntStats;
    try {
        current = await stat(entry.path, { bigint: true });
    } catch {
        return 'unchanged';
    }
    if (!current.isFile()) return 'unchanged';
    return entry.known?.mtimeMs === Number(current.mtimeMs) &&
        entry.known.size === Number(current.size)
        ? 'unchanged'
        : 'changed';
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
            `File is larger than ${EXTERNAL_FILE_SIZE_LIMIT_LABEL} and can't be saved here.`,
        );
    const authorized = await authorizedTarget(documentId);
    const entry = documents.get(documentId)!;
    let file: Awaited<ReturnType<typeof open>>;
    try {
        file = await open(
            authorized.path,
            constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
    } catch (error) {
        return pathFailure(error, 'Unable to open external file for writing');
    }
    entry.writes += 1;
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
                "This file is hard-linked elsewhere, so Caxri can't save it safely. Use Open with Default App.",
            );
        /**
         * Every check runs before the first byte is written. Once truncation starts, the descriptor (already proven to
         * be the authorized file) receives the bytes whatever happens to the path, so a check failing afterwards would
         * report a failed save for a file that was in fact written.
         */
        if ((await realpath(authorized.path)) !== authorized.path)
            throw new CaxriError('CONFLICT', 'File changed before it was saved');
        await validateDirectory(authorized.identity.root);
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
        const written = await file.stat({ bigint: true });
        const state = { mtimeMs: Number(written.mtimeMs), size: Number(written.size) };
        entry.known = state;
        return { content, ...state };
    } catch (error) {
        return pathFailure(error, 'Unable to save external file');
    } finally {
        entry.writes -= 1;
        await file.close();
    }
}

/**
 * Test-only reset; Main's registry otherwise lives for the whole process.
 */
export function clearExternalDocumentsForTesting(): void {
    documents.clear();
}

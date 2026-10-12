import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

import type { MethodResult } from '@caxri/protocol';
import { CaxriError, previewAssetByteLimit, previewAssetMediaType } from '@caxri/protocol';
import { formatBytes } from '@caxri/utils';

import { authorizedExternalDocument, isExternalDocumentWriting } from './external-documents';
import { readExternalFile, readExternalFileSnapshot } from './external-file-snapshot';
import { pathFailure } from './path-browser-identity';

/**
 * Reads a registered document again (after another app changed it) under the folder identity it was first read with, so
 * a folder swapped out from under the path is refused rather than followed. A read during Caxri's own save is refused
 * too: the Renderer keeps its buffer on a failed read, where a half-written file would replace it.
 */
export async function readExternalDocument(
    documentId: string,
): Promise<MethodResult<'externalDocument.read'>> {
    if (isExternalDocumentWriting(documentId))
        throw new CaxriError('CONFLICT', 'Document is being saved');
    const authorized = await authorizedExternalDocument(documentId);
    const { content, mtimeMs, size } = await readExternalFile(
        authorized.parent,
        authorized.path,
        basename(authorized.path),
    );
    return { content, mtimeMs, size };
}

function isInside(directory: string, path: string): boolean {
    return path.startsWith(directory.endsWith(sep) ? directory : directory + sep);
}

/**
 * Resolves a path a document refers to, relative to the document's folder, and holds it to that folder and the folders
 * below it. The opened document is the user's whole grant: a link may not climb out of its folder, lexically or through
 * a symbolic link to a folder elsewhere. Returns the target with its folder canonicalized.
 */
async function resolveLinkedPath(documentId: string, relativePath: string): Promise<string> {
    const directory = dirname((await authorizedExternalDocument(documentId)).path);
    const lexical = resolve(directory, relativePath);
    if (!isInside(directory, lexical))
        throw new CaxriError('PATH_DENIED', 'Linked file is outside the document folder');
    let parent: string;
    try {
        parent = await realpath(dirname(lexical));
    } catch (error) {
        return pathFailure(error, 'Unable to inspect linked file location');
    }
    if (parent !== directory && !isInside(directory, parent))
        throw new CaxriError('PATH_DENIED', 'Linked file is outside the document folder');
    return join(parent, basename(lexical));
}

/**
 * Opens a file a document links to as another external document, through the same checked read as any external file.
 */
export async function openLinkedExternalDocument(
    documentId: string,
    relativePath: string,
): Promise<MethodResult<'externalDocument.openLinked'>> {
    return readExternalFileSnapshot(await resolveLinkedPath(documentId, relativePath));
}

/**
 * Reads an image a document's preview shows, with the same limits as a Project preview asset (`files.readAsset`): an
 * extension from the preview allowlist, a regular file reached without a symbolic link, one filesystem link, and the
 * preview size ceiling for its media type.
 */
export async function readExternalDocumentAsset(
    documentId: string,
    relativePath: string,
): Promise<MethodResult<'externalDocument.readAsset'>> {
    const path = await resolveLinkedPath(documentId, relativePath);
    const mediaType = previewAssetMediaType(path);
    if (!mediaType) throw new CaxriError('PATH_DENIED', 'File type cannot be previewed');
    let file: Awaited<ReturnType<typeof open>>;
    try {
        const entry = await lstat(path, { bigint: true });
        if (!entry.isFile()) throw new CaxriError('IO', 'Path is not a file');
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const opened = await file.stat({ bigint: true });
        if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) {
            await file.close();
            throw new CaxriError('IO', 'File changed during read');
        }
    } catch (error) {
        return pathFailure(error, 'Unable to open linked image');
    }
    try {
        const opened = await file.stat();
        if (opened.nlink > 1)
            throw new CaxriError(
                'PATH_DENIED',
                'Files with multiple filesystem links cannot be read',
            );
        const limit = previewAssetByteLimit(mediaType);
        if (opened.size > limit)
            throw new CaxriError(
                'CAPACITY',
                `File exceeds the ${formatBytes(limit)} preview limit`,
            );
        const buffer = await file.readFile();
        if (buffer.byteLength > limit)
            throw new CaxriError('CAPACITY', 'Asset grew past the preview limit while it was read');
        return { path, mediaType, base64: buffer.toString('base64'), size: buffer.byteLength };
    } finally {
        await file.close();
    }
}

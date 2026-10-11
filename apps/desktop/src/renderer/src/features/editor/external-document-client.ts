import { caxri } from '../../lib/caxri';

/**
 * Requests on external documents (files outside every Project) that Main resolves from the opaque ID it issued; the
 * Renderer never names their paths.
 */
export function readExternalDocument(documentId: string) {
    return caxri.request('externalDocument.read', { documentId });
}

/**
 * Replaces the set Main watches for changes by other apps. A refused watch only costs change notices, never a buffer,
 * so it is not reported.
 */
export async function watchExternalDocuments(documentIds: readonly string[]): Promise<void> {
    try {
        await caxri.request('externalDocument.watch', { documentIds: [...documentIds] });
    } catch {
        // See above: the open buffers are unaffected.
    }
}

/**
 * Opens a file a document links to; `path` is relative to that document's folder.
 */
export function openLinkedExternalFile(documentId: string, path: string) {
    return caxri.request('externalDocument.openLinked', { documentId, path });
}

import type { FileDocument } from '@caxri/protocol';

export interface EditorDocument extends FileDocument {
    dirty: boolean;
}

export type SessionDocuments = Record<string, Record<string, EditorDocument>>;

/**
 * Monaco models are URI-keyed, so Session identity must be part of the URI even for a shared root.
 */
export function editorModelPath(sessionId: string, path: string): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const encodedPath = normalizedPath.split('/').map(encodeURIComponent).join('/');
    return `caxri://session/${encodeURIComponent(sessionId)}${encodedPath}`;
}

export function setSessionDocument(
    documents: SessionDocuments,
    sessionId: string,
    document: EditorDocument,
): SessionDocuments {
    return {
        ...documents,
        [sessionId]: {
            ...documents[sessionId],
            [document.path]: document,
        },
    };
}

/**
 * Disk state always wins, even over a dirty buffer, by explicit Caxri product policy.
 */
export function replaceWithExternalDocument(document: FileDocument): EditorDocument {
    return { ...document, dirty: false };
}

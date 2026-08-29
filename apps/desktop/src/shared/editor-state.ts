import type { FileDocument } from '@caxri/protocol';
import { parseExternalEditorTab } from '@caxri/protocol';

export interface EditorDocument extends FileDocument {
    dirty: boolean;
    /**
     * Main-authorized external documents are view-only and must never reach the Project-scoped save path.
     */
    readOnly?: boolean;
    /**
     * Marks content whose lifetime is the current Renderer. It is retained while its tab is open and never restored
     * from SQLite.
     */
    ephemeral?: boolean;
    /**
     * User-facing absolute path for an opaque external resource. The Monaco and pane resource identity remains virtual.
     */
    displayPath?: string;
}

export type SessionDocuments = Record<string, Record<string, EditorDocument>>;

/**
 * Monaco models are URI-keyed, so Session identity must be part of the URI even for a shared root.
 */
export function editorModelPath(sessionId: string, path: string): string {
    const external = parseExternalEditorTab(path);
    /**
     * Do not nest the external tab's URI scheme inside Monaco's Session URI. Monaco's TypeScript worker treats the
     * encoded `scheme://` segment as an invalid source-file path and reports an unhandled missing-source error. A clean
     * opaque segment preserves the document identity and extension without exposing its real filesystem path.
     */
    const resourcePath = external ? `/external/${external.documentId}/${external.name}` : path;
    const normalizedPath = resourcePath.startsWith('/') ? resourcePath : `/${resourcePath}`;
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

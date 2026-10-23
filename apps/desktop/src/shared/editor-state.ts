import type { FileDocument } from '@caxri/protocol';
import { parseExternalEditorTab, parseUntitledEditorTab } from '@caxri/protocol';

export interface EditorDocument extends FileDocument {
    dirty: boolean;
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

const EDITOR_MODEL_SCHEME = 'caxri';
const EDITOR_MODEL_AUTHORITY = 'session';
const EXTERNAL_MODEL_SEGMENT = '/external/';
const UNTITLED_MODEL_SEGMENT = '/untitled/';

/**
 * Monaco models are URI-keyed, so Session identity must be part of the URI even for a shared root.
 */
export function editorModelPath(sessionId: string, path: string): string {
    const external = parseExternalEditorTab(path);
    const untitled = parseUntitledEditorTab(path);
    /**
     * Do not nest the external tab's URI scheme inside Monaco's Session URI. Monaco's TypeScript worker treats the
     * encoded `scheme://` segment as an invalid source-file path and reports an unhandled missing-source error. A clean
     * opaque segment preserves the document identity and extension without exposing its real filesystem path. An
     * untitled buffer gets the same treatment, with no extension, so Monaco starts it as Plain Text.
     */
    const resourcePath = external
        ? `${EXTERNAL_MODEL_SEGMENT}${external.documentId}/${external.name}`
        : untitled === undefined
          ? path
          : `${UNTITLED_MODEL_SEGMENT}Untitled-${untitled}`;
    const normalizedPath = resourcePath.startsWith('/') ? resourcePath : `/${resourcePath}`;
    const encodedPath = normalizedPath.split('/').map(encodeURIComponent).join('/');
    return `${EDITOR_MODEL_SCHEME}://${EDITOR_MODEL_AUTHORITY}/${encodeURIComponent(sessionId)}${encodedPath}`;
}

/**
 * Inverse of `editorModelPath`, reading the already percent-decoded components Monaco exposes on a model's URI. Kept
 * beside the builder so the Session-scoped URI layout has exactly one definition.
 *
 * Answers nothing for a URI this module did not build and for an external document, whose first segment is an opaque
 * identity rather than a filesystem path, and for an untitled buffer, which has no file: a caller that needs a real
 * Project file must not treat it as one.
 */
export function parseEditorModelPath(uri: {
    authority: string;
    path: string;
    scheme: string;
}): { path: string; sessionId: string } | undefined {
    if (uri.scheme !== EDITOR_MODEL_SCHEME || uri.authority !== EDITOR_MODEL_AUTHORITY)
        return undefined;
    const separator = uri.path.indexOf('/', 1);
    if (separator === -1 || !uri.path.startsWith('/')) return undefined;
    const path = uri.path.slice(separator);
    if (path.startsWith(EXTERNAL_MODEL_SEGMENT) || path.startsWith(UNTITLED_MODEL_SEGMENT))
        return undefined;
    // A Session viewing another Workbench root carries `<sessionId>\0<projectId>` as its scope; only the Session half
    // is a Session identifier.
    const [sessionId] = uri.path.slice(1, separator).split('\0', 1);
    return sessionId ? { path, sessionId } : undefined;
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

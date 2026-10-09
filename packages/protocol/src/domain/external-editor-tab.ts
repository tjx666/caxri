const EXTERNAL_EDITOR_TAB_PREFIX = 'caxri-external-file://';

export interface ExternalEditorTab {
    documentId: string;
    name: string;
}

/**
 * Gives a Main-authorized external document an opaque Renderer resource identity. The real filesystem path stays in the
 * Renderer-only document cache and never enters durable Session layout state.
 */
export function externalEditorTabPath(documentId: string, name: string): string {
    return `${EXTERNAL_EDITOR_TAB_PREFIX}${encodeURIComponent(documentId)}/${encodeURIComponent(name)}`;
}

export function parseExternalEditorTab(path: string): ExternalEditorTab | undefined {
    if (!path.startsWith(EXTERNAL_EDITOR_TAB_PREFIX)) return undefined;
    const encoded = path.slice(EXTERNAL_EDITOR_TAB_PREFIX.length);
    const separator = encoded.indexOf('/');
    if (separator <= 0 || separator === encoded.length - 1) return undefined;
    try {
        const documentId = decodeURIComponent(encoded.slice(0, separator));
        const name = decodeURIComponent(encoded.slice(separator + 1));
        if (!documentId || !name || documentId.length > 200 || name.length > 255) return undefined;
        return { documentId, name };
    } catch {
        return undefined;
    }
}

export function isExternalEditorTabPath(path: string): boolean {
    return parseExternalEditorTab(path) !== undefined;
}

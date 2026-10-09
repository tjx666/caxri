import {
    isExternalEditorTabPath,
    isVirtualEditorTabPath,
    parseExternalEditorTab,
} from '@caxri/protocol';

import { caxri } from '../../lib/caxri';

/**
 * Project files save through Server Core's `files.write`. An external document has no Project to authorize it, so Main
 * writes it back to the file it read, named only by the opaque ID inside the tab path.
 */
export async function writeEditorDocument(sessionId: string, path: string, content: string) {
    const external = parseExternalEditorTab(path);
    if (!external) return caxri.request('files.write', { sessionId, path, content });
    const written = await caxri.request('externalDocument.write', {
        documentId: external.documentId,
        content,
    });
    return { ...written, path };
}

/**
 * Whether a tab path names a document the user can save. Virtual tabs (Settings, diffs, previews) have nothing to write
 * back, except an external document, which saves through Main.
 */
export function isSavableEditorPath(path: string): boolean {
    return !isVirtualEditorTabPath(path) || isExternalEditorTabPath(path);
}

import { isAgentTranscriptTabPath } from './agent-transcript.js';
import { isFilePreviewTabPath } from './file-preview.js';
import { isGitDiffTabPath } from './git-diff.js';
import { isSettingsTabPath } from './settings-tab.js';

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

/**
 * Editor tab paths that name a virtual surface instead of a Project file. Virtual tabs are never read or written
 * through `files.*`, are skipped by save and dirty-close confirmation, and keep their encoded path across file renames.
 * Every new virtual tab scheme must be added here so all of those guards stay in one place.
 */
export function isVirtualEditorTabPath(path: string): boolean {
    return (
        isGitDiffTabPath(path) ||
        isAgentTranscriptTabPath(path) ||
        isExternalEditorTabPath(path) ||
        isFilePreviewTabPath(path) ||
        isSettingsTabPath(path)
    );
}

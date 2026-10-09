import { isExternalEditorTabPath, parseExternalEditorTab } from './external-editor-tab.js';

/**
 * Virtual editor tab that renders a file instead of editing it: Markdown as formatted text, `.svg` as an image. The
 * source is a Project file's absolute path or an external document's opaque tab path. The tab encodes the source path,
 * so it persists and restores like any other tab and the same file can sit open as source in one pane and as a preview
 * in another.
 *
 * Which renderer a path gets is decided by the Renderer's previewer registry, not by the scheme, so adding a format
 * never changes this contract.
 */
export interface FilePreviewTab {
    path: string;
}

const FILE_PREVIEW_TAB_PREFIX = 'caxri-file-preview://';

export function filePreviewTabPath(path: string): string {
    return `${FILE_PREVIEW_TAB_PREFIX}${encodeURIComponent(path)}`;
}

export function parseFilePreviewTab(tabPath: string): FilePreviewTab | undefined {
    if (!tabPath.startsWith(FILE_PREVIEW_TAB_PREFIX)) return undefined;
    const encoded = tabPath.slice(FILE_PREVIEW_TAB_PREFIX.length);
    if (!encoded) return undefined;
    try {
        const path = decodeURIComponent(encoded);
        return path.startsWith('/') || isExternalEditorTabPath(path) ? { path } : undefined;
    } catch {
        return undefined;
    }
}

export function isFilePreviewTabPath(tabPath: string): boolean {
    return Boolean(parseFilePreviewTab(tabPath));
}

/**
 * Lowercased extension without the dot, or an empty string for a dotfile or extensionless name.
 */
export function filePreviewExtension(path: string): string {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function filePreviewTabLabel(path: string): string {
    const external = parseExternalEditorTab(path);
    return `Preview: ${external ? external.name : path.slice(path.lastIndexOf('/') + 1)}`;
}

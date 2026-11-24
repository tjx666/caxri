import { isHtmlPreviewPath, parseExternalEditorTab, parseFilePreviewTab } from '@caxri/protocol';

import {
    openExternalDocumentWithDefaultApp,
    openFileWithDefaultApp,
} from '../../../lib/desktop-file-actions';

/**
 * The HTML page an editor tab shows, as source or as its preview, or `undefined` for any other tab. An external page is
 * named by its document ID, because the Renderer never holds an external document's path as an authority.
 */
export type HtmlPageTarget =
    { kind: 'external'; documentId: string } | { kind: 'project'; path: string };

export function htmlPageTarget(tabPath: string): HtmlPageTarget | undefined {
    const path = parseFilePreviewTab(tabPath)?.path ?? tabPath;
    if (!isHtmlPreviewPath(path)) return undefined;
    const external = parseExternalEditorTab(path);
    if (external) return { kind: 'external', documentId: external.documentId };
    return path.startsWith('/') ? { kind: 'project', path } : undefined;
}

/**
 * Opens the page in the browser the system registers for HTML, from its source tab or its preview tab alike.
 */
export function openHtmlPageInBrowser(target: HtmlPageTarget): Promise<void | undefined> {
    return target.kind === 'external'
        ? openExternalDocumentWithDefaultApp(target.documentId)
        : openFileWithDefaultApp(target.path);
}

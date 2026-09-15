import { filePreviewTabPath, isVirtualEditorTabPath, parseFilePreviewTab } from '@caxri/protocol';

import { openEditorTab } from '../editor/document-commands';
import {
    findPaneTabId,
    getActivePaneId,
    getActivePaneTab,
    splitPaneTab,
} from '../workbench/pane-actions';
import { canPreviewPath } from './preview-registry';

/**
 * The file the preview commands act on: the active tab's document, or — when a preview tab is already focused — the
 * document that preview is showing, so re-running the command from the preview is a no-op instead of an error.
 */
export function activePreviewSourcePath(): string | undefined {
    const tab = getActivePaneTab();
    if (tab?.resource.kind !== 'file') return undefined;
    const preview = parseFilePreviewTab(tab.resource.path);
    if (preview) return preview.path;
    if (isVirtualEditorTabPath(tab.resource.path)) return undefined;
    return canPreviewPath(tab.resource.path) ? tab.resource.path : undefined;
}

export function canOpenActivePreview(): boolean {
    return activePreviewSourcePath() !== undefined;
}

export function openFilePreview(path: string): void {
    if (!canPreviewPath(path)) return;
    openEditorTab(filePreviewTabPath(path));
}

/**
 * Opens the preview beside its source.
 *
 * The preview tab is created in the active pane first and then split off it, which is exactly what dragging the tab to
 * the pane's right edge does — so side-by-side preview needs no placement rules of its own. A pane holding nothing but
 * that new tab cannot be split (splitting its only tab would just move the pane), and the preview stays where it is.
 */
export function openFilePreviewToSide(path: string): void {
    if (!canPreviewPath(path)) return;
    const tabPath = filePreviewTabPath(path);
    openEditorTab(tabPath);
    const paneId = getActivePaneId();
    const tabId = findPaneTabId({ kind: 'file', path: tabPath });
    if (paneId && tabId) splitPaneTab(tabId, paneId, 'right');
}

export function openActiveFilePreview(): void {
    const path = activePreviewSourcePath();
    if (path) openFilePreview(path);
}

export function openActiveFilePreviewToSide(): void {
    const path = activePreviewSourcePath();
    if (path) openFilePreviewToSide(path);
}

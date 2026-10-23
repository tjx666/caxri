import type { PaneLayout } from '@caxri/protocol';
import { findTab, isExternalEditorTabPath, parseFilePreviewTab } from '@caxri/protocol';

import { getSessionDocuments } from '../../stores/session-view';
import type { ClosedTabItem } from './stack';
import { closedItems, isRecordableTabPath } from './stack';

/**
 * Remembers the editor tabs a close just removed. Called with the layout from before the close so each tab keeps its
 * pane and index, and before the close evicts the documents so an external document's content can be captured.
 *
 * `isDirty` is only consulted for external documents.
 */
export function recordClosedTabs(
    sessionId: string,
    layoutBeforeClose: PaneLayout,
    tabIds: readonly string[],
    isDirty: (path: string) => boolean,
): void {
    const items = tabIds.flatMap((tabId): ClosedTabItem[] => {
        const found = findTab(layoutBeforeClose, tabId);
        if (found?.tab.resource.kind !== 'file') return [];
        const path = found.tab.resource.path;
        if (!isRecordableTabPath(path)) return [];
        const sourcePath = parseFilePreviewTab(path)?.path ?? path;
        const isExternal = isExternalEditorTabPath(sourcePath);
        const document = isExternal ? getSessionDocuments(sessionId)?.[sourcePath] : undefined;
        // An external document lives only in the Renderer cache and the close evicts it, so its content is kept here.
        // Discarded unsaved edits leave nothing faithful to restore. A Project file is simply re-read from disk.
        if (isExternal && (!document || isDirty(sourcePath))) return [];
        return [
            {
                kind: 'tab',
                sessionId,
                paneId: found.pane.id,
                index: found.pane.tabs.indexOf(found.tab),
                path,
                ...(document && { document }),
            },
        ];
    });
    closedItems.push(items);
}

export function recordClosedSession(sessionId: string): void {
    closedItems.push([{ kind: 'session', sessionId }]);
}

export function forgetDeletedSessions(sessionIds: readonly string[]): void {
    closedItems.forgetSessions(sessionIds);
}

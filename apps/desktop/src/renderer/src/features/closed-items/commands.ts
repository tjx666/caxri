import {
    findPane,
    findResourceTabs,
    isExternalEditorTabPath,
    isVirtualEditorTabPath,
} from '@caxri/protocol';
import { editorModelPath } from '@desktop-shared/editor-state';

import { getBootstrap } from '../../stores/selectors';
import { sessionViewScope, useSessionViewStore } from '../../stores/session-view';
import { didOpenEditorTabForSession, openFileForSession } from '../editor/document-commands';
import { focusEditor } from '../editor/editor-reveal';
import { sessionStateOf } from '../editor/session-pane-state';
import { restoreArchivedSession } from '../session/session-archive-commands';
import { didSelectSession } from '../session/session-commands';
import { movePaneTab } from '../workbench/pane-actions';
import type { ClosedItem, ClosedSessionItem, ClosedTabItem } from './stack';
import { closedItems } from './stack';

/**
 * Makes the Session the Open Session when it is not already, which is where a closed tab has to come back.
 */
async function didShowSession(sessionId: string): Promise<boolean> {
    if (getBootstrap()?.selectedSessionId === sessionId) return true;
    return didSelectSession(sessionId);
}

async function didReopenSession(item: ClosedSessionItem): Promise<boolean> {
    const session = getBootstrap()?.sessions.find((candidate) => candidate.id === item.sessionId);
    if (!session) return false;
    // Restored by hand since it was archived: nothing to restore, but it is still what the user asked to bring back.
    if (session.archivedAt !== undefined && !(await restoreArchivedSession(item.sessionId)))
        return false;
    return didShowSession(item.sessionId);
}

async function didReopenTab(item: ClosedTabItem): Promise<boolean> {
    const session = getBootstrap()?.sessions.find((candidate) => candidate.id === item.sessionId);
    // An archived Session's tabs come back with the Session (its own entry is newer), not into a hidden Session.
    if (!session || session.archivedAt !== undefined) return false;
    if (!(await didShowSession(item.sessionId))) return false;
    const before = sessionStateOf(item.sessionId);
    if (!before) return false;
    // Already open (reopened by hand, or by an earlier press): nothing to bring back.
    if (findResourceTabs(before.paneLayout, { kind: 'file', path: item.path }).length > 0)
        return false;
    const paneId = findPane(before.paneLayout, item.paneId)?.id;
    if (item.document)
        useSessionViewStore
            .getState()
            .cacheDocument(
                item.sessionId,
                { ...item.document, dirty: false },
                before.workbenchProjectId,
            );
    const isOpened = isVirtualEditorTabPath(item.path)
        ? didOpenEditorTabForSession(item.sessionId, item.path, { paneId })
        : (await openFileForSession(item.sessionId, item.path, { paneId })) !== false;
    if (!isOpened) return false;
    const reopened = sessionStateOf(item.sessionId);
    const occurrence =
        reopened &&
        findResourceTabs(reopened.paneLayout, { kind: 'file', path: item.path }).find(
            ({ pane }) => pane.id === (paneId ?? reopened.paneLayout.activePaneId),
        );
    if (!occurrence) return true;
    if (paneId) movePaneTab(occurrence.tab.id, occurrence.pane.id, item.index);
    // A text editor takes keyboard focus like a freshly opened file; other surfaces have no editor to focus.
    if (!isVirtualEditorTabPath(item.path) || isExternalEditorTabPath(item.path))
        focusEditor(
            editorModelPath(
                sessionViewScope(item.sessionId, reopened.workbenchProjectId),
                item.path,
            ),
            occurrence.pane.id,
        );
    return true;
}

function reopenItem(item: ClosedItem): Promise<boolean> {
    return item.kind === 'session' ? didReopenSession(item) : didReopenTab(item);
}

/**
 * Reopens the most recently closed editor tab or Session that can still be reopened, skipping entries whose Session was
 * deleted or whose file no longer opens. Each call walks one step further back, like the browser and VS Code.
 */
export async function reopenClosedItem(): Promise<void> {
    await closedItems.reopenNext(reopenItem);
}

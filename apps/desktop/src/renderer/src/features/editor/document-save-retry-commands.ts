import { findTab } from '@caxri/protocol';

import { translate } from '../../i18n';
import type { ToastActionParameters } from '../../stores/toast-actions';
import { didSaveDocumentAt } from './document-commands';
import { sessionStateOf } from './session-pane-state';

type SaveRetryTarget = ToastActionParameters['editor.retrySave'];

/**
 * Which editor a failed save would be retried in, or undefined once there is no longer one.
 *
 * The buffer itself is deliberately not part of a retry's identity: it is re-read at retry time so a retry cannot
 * overwrite edits made after the failure; so all that has to survive the notification is the tab. A preview tab is
 * refused outright: recovering through a reusable slot would save a replacement document.
 */
function retrySaveTarget(target: SaveRetryTarget): FileTabTarget | undefined {
    const state = sessionStateOf(target.sessionId);
    const tab = state && target.tabId ? findTab(state.paneLayout, target.tabId)?.tab : undefined;
    return state?.workbenchRootProjectId === target.workbenchRootProjectId &&
        tab?.resource.kind === 'file' &&
        tab.preview !== true
        ? { path: tab.resource.path }
        : undefined;
}

interface FileTabTarget {
    path: string;
}

export function saveRetryUnavailableReason(target: SaveRetryTarget): string | undefined {
    return retrySaveTarget(target) ? undefined : translate('editor.document.saveRetryUnavailable');
}

/**
 * Saves the document a failed save belonged to, from whatever its buffer holds now.
 */
export function retrySaveDocument(target: SaveRetryTarget): void {
    const resolved = retrySaveTarget(target);
    if (!resolved) return;
    void didSaveDocumentAt(target.sessionId, resolved.path);
}

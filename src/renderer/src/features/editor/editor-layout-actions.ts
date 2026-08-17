import {
    moveEditorPath,
    resizeSplit as resizeEditorSplitLayout,
    sessionEditorLayout,
    splitEditorPath,
} from '@shared/editor-layout';
import type { EditorLayout } from '@shared/types';

import { getSessionState } from '../../stores/selectors';
import { useSessionViewStore } from '../../stores/session-view';
import { patchSessionState } from '../../stores/workbench';

export { EDITOR_DRAG_TYPE } from './editor-drop-zone';

/**
 * Layout edits (drag, drop, splitter resize) write the layout without moving Editor focus. Mirrors
 * `applyTerminalLayout`'s shape, but stays module-private: every current write site also wants to activate the changed
 * path, so callers use {@link splitEditorTabTo}/{@link moveEditorTabToGroup}/{@link resizeEditorSplit} instead of
 * composing this with {@link activateEditorTab} themselves.
 */
function applyEditorLayout(layout: EditorLayout): void {
    const current = getSessionState();
    if (current) patchSessionState({ ...current, editorLayout: layout });
}

/**
 * Activates `path` as the Session's focused work item, updating both the in-memory `activeWork` map and the persisted
 * `activeTab`/`editorLayout` fields via `activateWorkState`. Pass `groupId` when the click came from a specific pane so
 * a duplicated path activates that group instead of staying on the already-active one.
 */
export function activateEditorTab(path: string, groupId?: string): void {
    useSessionViewStore
        .getState()
        .activateWork({ kind: 'editor', path }, groupId ? { editorGroupId: groupId } : undefined);
}

export function splitEditorTabTo(
    path: string,
    targetGroupId: string,
    direction: 'left' | 'right' | 'up' | 'down',
): void {
    const current = getSessionState();
    if (!current) return;
    const layout = sessionEditorLayout(current);
    const next = splitEditorPath(layout, path, targetGroupId, direction);
    if (next === layout) return;
    applyEditorLayout(next);
    activateEditorTab(path);
}

export function moveEditorTabToGroup(
    path: string,
    sourceGroupId: string,
    targetGroupId: string,
): void {
    const current = getSessionState();
    if (!current) return;
    const layout = sessionEditorLayout(current);
    const next = moveEditorPath(layout, path, sourceGroupId, targetGroupId);
    if (next === layout) return;
    applyEditorLayout(next);
    activateEditorTab(path);
}

export function resizeEditorSplit(splitId: string, ratio: number): void {
    const current = getSessionState();
    if (!current) return;
    const layout = sessionEditorLayout(current);
    applyEditorLayout(resizeEditorSplitLayout(layout, splitId, ratio));
}

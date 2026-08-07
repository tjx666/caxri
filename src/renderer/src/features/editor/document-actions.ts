import {
    editorTabPathsToClose,
    openEditorTabState,
    pinEditorTabState,
    updateEditorTabState,
    type EditorTabCloseMode,
} from '@shared/editor-state';
import { isGitDiffTabPath } from '@shared/git-diff';
import { activateWorkState, type WorkItem } from '@shared/work-item';

import { caxri } from '../../lib/caxri';
import { getSelectedSession, getSessionState, getSessionTerminals } from '../../stores/selectors';
import { getResolvedActiveWork, useSessionViewStore } from '../../stores/session-view';
import { tryCommand } from '../../stores/toasts';
import { patchSessionState } from '../../stores/workbench';
import { markEditorDocumentReady, markEditorOpenStarted } from './editor-performance';

let fileOpenIntent = 0;

/** Updates dirtiness and pins a preview as soon as it contains an edit. */
function updateOpenTab(path: string, dirty: boolean): void {
    const current = getSessionState();
    if (!current) return;
    const next = updateEditorTabState(current, path, dirty);
    if (next !== current) patchSessionState(next);
}

/** Opens a Renderer-owned editor surface whose content has already been loaded or is virtual. */
export function openEditorTab(path: string, options: { preview?: boolean } = {}): void {
    const session = getSelectedSession();
    const current = getSessionState();
    if (!session || !current) return;
    const opened = openEditorTabState(current, path, options.preview === true);
    if (opened.replacedPath)
        useSessionViewStore.getState().evictDocument(session.id, opened.replacedPath);
    const item: WorkItem = { kind: 'editor', path };
    useSessionViewStore.getState().setActiveWork(session.id, item);
    const next = activateWorkState(opened.state, item);
    if (next !== current) patchSessionState(next);
}

/** Reads a file into the Session document cache without changing the focused WorkItem. */
export async function cacheDocument(sessionId: string, path: string): Promise<void> {
    await tryCommand('Unable to restore file', async () => {
        const document = await caxri.request('files.read', { sessionId, path });
        useSessionViewStore.getState().cacheDocument(sessionId, { ...document, dirty: false });
    });
}

export async function openFile(
    path: string,
    options: { preview?: boolean } = {},
): Promise<boolean> {
    const session = getSelectedSession();
    if (!session) return false;
    const intent = ++fileOpenIntent;
    markEditorOpenStarted();
    const opened = await tryCommand('Unable to open file', async () => {
        const document = await caxri.request('files.read', { sessionId: session.id, path });
        if (intent !== fileOpenIntent || getSelectedSession()?.id !== session.id) return false;
        markEditorDocumentReady();
        useSessionViewStore.getState().cacheDocument(session.id, { ...document, dirty: false });
        openEditorTab(path, options);
        return true;
    });
    return opened === true;
}

/** Selecting an already open tab reuses the cached buffer; an evicted one is read again. */
export function selectEditorTab(path: string): void {
    const session = getSelectedSession();
    if (!session) return;
    if (isGitDiffTabPath(path) || useSessionViewStore.getState().documents[session.id]?.[path])
        useSessionViewStore.getState().activateWork({ kind: 'editor', path });
    else void openFile(path);
}

export function changeDocument(path: string, content: string): void {
    const session = getSelectedSession();
    if (!session) return;
    useSessionViewStore.getState().updateDocumentContent(session.id, path, content);
    updateOpenTab(path, true);
}

export function pinEditorTab(path: string): void {
    const current = getSessionState();
    if (!current) return;
    const next = pinEditorTabState(current, path);
    if (next !== current) patchSessionState(next);
}

export async function saveActiveEditor(): Promise<void> {
    const session = getSelectedSession();
    const active = getResolvedActiveWork();
    if (!session || active?.kind !== 'editor') return;
    const path = active.path;
    if (isGitDiffTabPath(path)) return;
    const document = useSessionViewStore.getState().documents[session.id]?.[path];
    if (!document) return;
    await tryCommand('Save failed', async () => {
        const saved = await caxri.request('files.write', {
            sessionId: session.id,
            path,
            content: document.content,
        });
        useSessionViewStore.getState().cacheDocument(session.id, { ...saved, dirty: false });
        updateOpenTab(path, false);
    });
}

function closeEditors(targetPath: string, mode: EditorTabCloseMode): void {
    const session = getSelectedSession();
    const current = getSessionState();
    if (!session || !current) return;
    const paths = editorTabPathsToClose(current.openTabs, targetPath, mode);
    if (paths.length === 0) return;
    const closing = new Set(paths);
    for (const path of paths) useSessionViewStore.getState().evictDocument(session.id, path);
    const openTabs = current.openTabs.filter((tab) => !closing.has(tab.path));
    const wasActive = current.activeTab?.kind === 'editor' && closing.has(current.activeTab.path);
    if (!wasActive) {
        patchSessionState({ ...current, openTabs });
        return;
    }
    const targetIndex = current.openTabs.findIndex((tab) => tab.path === targetPath);
    const fallbackPath =
        openTabs.find((tab) => tab.path === targetPath)?.path ??
        openTabs[Math.min(Math.max(targetIndex, 0), openTabs.length - 1)]?.path;
    const sessionTerminals = getSessionTerminals();
    const nextItem: WorkItem | undefined = fallbackPath
        ? { kind: 'editor', path: fallbackPath }
        : sessionTerminals[0]
          ? { kind: 'terminal', terminalId: sessionTerminals[0].id }
          : undefined;
    useSessionViewStore.getState().setActiveWork(session.id, nextItem);
    /**
     * Reuses `activateWorkState` rather than `activateWork` so the openTabs removal and the fallback
     * selection persist atomically instead of as two IPC round trips.
     */
    patchSessionState(
        nextItem
            ? activateWorkState({ ...current, openTabs }, nextItem)
            : { ...current, openTabs, activeTab: undefined },
    );
}

export function closeEditor(path: string): void {
    closeEditors(path, 'one');
}

export function closeOtherEditors(path: string): void {
    closeEditors(path, 'others');
}

export function closeEditorsToRight(path: string): void {
    closeEditors(path, 'right');
}

export function closeAllEditors(path: string): void {
    closeEditors(path, 'all');
}

import { updateEditorTabState } from '@shared/editor-state';
import { isGitDiffTabPath } from '@shared/git-diff';
import { activateWorkState, type WorkItem } from '@shared/work-item';

import { caxri } from '../../lib/caxri';
import { getSelectedSession, getSessionState, getSessionTerminals } from '../../stores/selectors';
import { getResolvedActiveWork, useSessionViewStore } from '../../stores/session-view';
import { tryCommand } from '../../stores/toasts';
import { patchSessionState } from '../../stores/workbench';

/** Open-tab bookkeeping only; which WorkItem is focused stays owned by `activateWork`. */
function updateOpenTab(path: string, dirty: boolean): void {
    const current = getSessionState();
    if (!current) return;
    const next = updateEditorTabState(current, path, dirty);
    if (next !== current) patchSessionState(next);
}

/** Opens a Renderer-owned editor surface whose content has already been loaded or is virtual. */
export function openEditorTab(path: string): void {
    updateOpenTab(path, false);
    useSessionViewStore.getState().activateWork({ kind: 'editor', path });
}

/** Reads a file into the Session document cache without changing the focused WorkItem. */
export async function cacheDocument(sessionId: string, path: string): Promise<void> {
    await tryCommand('Unable to restore file', async () => {
        const document = await caxri.request('files.read', { sessionId, path });
        useSessionViewStore.getState().cacheDocument(sessionId, { ...document, dirty: false });
    });
}

export async function openFile(path: string): Promise<void> {
    const session = getSelectedSession();
    if (!session) return;
    await tryCommand('Unable to open file', async () => {
        const document = await caxri.request('files.read', { sessionId: session.id, path });
        useSessionViewStore.getState().cacheDocument(session.id, { ...document, dirty: false });
        openEditorTab(path);
    });
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

export function closeEditor(path: string): void {
    const session = getSelectedSession();
    const current = getSessionState();
    if (!session || !current) return;
    useSessionViewStore.getState().evictDocument(session.id, path);
    const openTabs = current.openTabs.filter((tab) => tab.path !== path);
    const wasActive = current.activeTab?.kind === 'editor' && current.activeTab.path === path;
    if (!wasActive) {
        patchSessionState({ ...current, openTabs });
        return;
    }
    const fallbackPath = openTabs.at(-1)?.path;
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

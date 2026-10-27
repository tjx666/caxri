import type { AppSettings, BootstrapState, SessionState } from '@caxri/protocol';

import { useSessionViewStore } from '../../../stores/session-view';
import { useWorkbenchStore } from '../../../stores/workbench';
import { findPaneTabId } from '../../workbench/pane-actions';
import { closeDocumentTabFamily, closeDocumentTabs } from '../document-commands';

/**
 * Fixture Sessions install auto save `off`, so a close exercises the Save/Don't Save/Cancel confirmation. A test of
 * auto save switches the mode after installing.
 */
export function setAutoSave(mode: AppSettings['files.autoSave']): void {
    useWorkbenchStore.setState((state) => ({
        bootstrap: state.bootstrap && {
            ...state.bootstrap,
            settings: { ...state.bootstrap.settings, 'files.autoSave': mode },
        },
    }));
}

type PaneLayoutTabSpec = { path: string; preview?: boolean } | { terminalId: string };

/**
 * A single-pane layout with one tab per entry, in the given order; these tests only care that a document action
 * rewrites the pane's tabs, not about the tree's shape. A bare string is a document path, and a `terminalId` entry
 * places a Terminal in the same rail so mixed-pane close rules can be exercised.
 */
export function paneLayout(
    tabs: ReadonlyArray<string | PaneLayoutTabSpec>,
    activeIndex = 0,
): SessionState['paneLayout'] {
    const specs = tabs.map((tab) => (typeof tab === 'string' ? { path: tab } : tab));
    return {
        root: {
            type: 'pane',
            id: 'pane-1',
            tabs: specs.map((spec, index) => ({
                id: `tab-${index}`,
                ...('terminalId' in spec
                    ? { resource: { kind: 'terminal' as const, terminalId: spec.terminalId } }
                    : {
                          resource: { kind: 'file' as const, path: spec.path },
                          ...(spec.preview && { preview: true }),
                      }),
            })),
            ...(specs.length > 0 && { activeTabId: `tab-${activeIndex}` }),
        },
        activePaneId: 'pane-1',
    };
}

function paneTabs(state: SessionState): Array<{ id: string; path: string }> {
    const pane = state.paneLayout.root;
    if (pane.type !== 'pane') throw new Error('Expected a single-pane layout');
    return pane.tabs.map((tab) => ({
        id: tab.id,
        path: tab.resource.kind === 'file' ? tab.resource.path : tab.resource.terminalId,
    }));
}

export function paneTabPaths(state: SessionState): string[] {
    return paneTabs(state).map((tab) => tab.path);
}

export function activePaneTabPath(state: SessionState): string | undefined {
    const pane = state.paneLayout.root;
    if (pane.type !== 'pane') throw new Error('Expected a single-pane layout');
    return paneTabs(state).find((tab) => tab.id === pane.activeTabId)?.path;
}

/**
 * Closes the given path's own tab in the currently selected Session, mirroring the single-tab close UI action (the
 * tab's own close button, Cmd+W).
 */
export async function closeEditor(path: string): Promise<void> {
    const tabId = findPaneTabId({ kind: 'file', path });
    if (tabId) await closeDocumentTabs([tabId]);
}

/**
 * Closes every tab in the given path's own pane, mirroring the Close All context-menu action.
 */
export async function closeAllEditors(path: string): Promise<void> {
    const tabId = findPaneTabId({ kind: 'file', path });
    if (tabId) await closeDocumentTabFamily(tabId, 'all');
}

const sessionState = (sessionId: string, path: string): SessionState => ({
    sessionId,
    revision: 0,
    workbenchRootProjectId: 'project-1',
    desiredSecondarySidebarViewContainerId: 'caxri.files',
    paneLayout: paneLayout([path]),
});

export function installSessions(
    originPath: string,
    selectedSessionId = 'session-2',
    secondSessionPath = '/other/session.ts',
): void {
    useWorkbenchStore.setState({
        bootstrap: {
            projects: [],
            selectedSessionId,
            sessions: [
                {
                    id: 'session-1',
                    projectId: 'project-1',
                    workbenchRootProjectId: 'project-1',
                },
                {
                    id: 'session-2',
                    projectId: 'project-1',
                    workbenchRootProjectId: 'project-1',
                },
            ],
            sessionStates: [
                sessionState('session-1', originPath),
                sessionState('session-2', secondSessionPath),
            ],
            terminals: [],
            settings: { 'files.autoSave': 'off' },
        } as unknown as BootstrapState,
    });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
    useSessionViewStore.getState().cacheDocument('session-1', {
        path: originPath,
        content: 'unsaved',
        dirty: true,
        mtimeMs: 1,
        size: 7,
    });
    useSessionViewStore.getState().cacheDocument('session-2', {
        path: secondSessionPath,
        content: 'other unsaved',
        dirty: true,
        mtimeMs: 1,
        size: 13,
    });
}

export function installEmptySession(): void {
    useWorkbenchStore.setState({
        bootstrap: {
            projects: [],
            selectedSessionId: 'session-1',
            sessions: [
                {
                    id: 'session-1',
                    projectId: 'project-1',
                    workbenchRootProjectId: 'project-1',
                },
            ],
            sessionStates: [
                {
                    sessionId: 'session-1',
                    revision: 0,
                    workbenchRootProjectId: 'project-1',
                    desiredSecondarySidebarViewContainerId: 'caxri.files',
                    paneLayout: paneLayout([]),
                },
            ],
            terminals: [],
            settings: { 'files.autoSave': 'off' },
        } as unknown as BootstrapState,
    });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
}

/**
 * An empty Session whose single pane is then filled with the given tabs, for the cases that need a specific rail rather
 * than the one-document-per-Session shape `installSessions` builds.
 */
export function installPaneLayout(
    tabs: ReadonlyArray<string | PaneLayoutTabSpec>,
    activeIndex = 0,
): void {
    installEmptySession();
    useWorkbenchStore.setState((state) => ({
        bootstrap: state.bootstrap
            ? {
                  ...state.bootstrap,
                  sessionStates: [
                      {
                          ...state.bootstrap.sessionStates[0],
                          paneLayout: paneLayout(tabs, activeIndex),
                      },
                  ],
              }
            : undefined,
    }));
}

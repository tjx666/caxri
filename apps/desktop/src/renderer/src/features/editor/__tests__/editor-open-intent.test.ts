import type { BootstrapState } from '@caxri/protocol';
import { settingsTabPath } from '@caxri/protocol';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn<(...arguments_: unknown[]) => Promise<unknown>>(() => Promise.resolve(null)),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { useSessionViewStore } from '../../../stores/session-view';
import { useWorkbenchStore } from '../../../stores/workbench';
import { selectPaneTab } from '../../workbench/pane-actions';
import { openEditorTab, openFileForSession } from '../document-commands';

function installTabs(paths: readonly string[], activeIndex: number): void {
    useWorkbenchStore.setState({
        bootstrap: {
            projects: [],
            selectedSessionId: 'session-1',
            sessions: [
                { id: 'session-1', projectId: 'project-1', workbenchProjectId: 'project-1' },
            ],
            sessionStates: [
                {
                    sessionId: 'session-1',
                    revision: 0,
                    workbenchProjectId: 'project-1',
                    desiredSecondarySidebarViewContainerId: 'caxri.files',
                    paneLayout: {
                        root: {
                            type: 'pane',
                            id: 'pane-1',
                            tabs: paths.map((path, index) => ({
                                id: `tab-${index}`,
                                resource: { kind: 'file' as const, path },
                            })),
                            activeTabId: `tab-${activeIndex}`,
                        },
                        activePaneId: 'pane-1',
                    },
                },
            ],
            terminals: [],
        } as unknown as BootstrapState,
    });
}

function activeTabId(): string | undefined {
    const root = useWorkbenchStore.getState().bootstrap?.sessionStates[0]?.paneLayout.root;
    return root?.type === 'pane' ? root.activeTabId : undefined;
}

function activeTabPath(): string | undefined {
    const root = useWorkbenchStore.getState().bootstrap?.sessionStates[0]?.paneLayout.root;
    if (root?.type !== 'pane') return undefined;
    const active = root.tabs.find((tab) => tab.id === root.activeTabId);
    return active?.resource.kind === 'file' ? active.resource.path : undefined;
}

afterEach(() => {
    mocks.request.mockReset();
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
});

it('keeps a tab the user selected while an earlier file open was still reading', async () => {
    installTabs(['/project/long.ts', '/project/short.ts'], 0);
    const read = Promise.withResolvers<unknown>();
    mocks.request.mockImplementation((method) =>
        method === 'files.read' ? read.promise : Promise.resolve(null),
    );

    const opening = openFileForSession('session-1', '/project/short.ts');
    selectPaneTab('tab-0');
    read.resolve({ content: 'short', mtimeMs: 1, path: '/project/short.ts', size: 5 });

    await expect(opening).resolves.toBe(false);
    expect(activeTabId()).toBe('tab-0');
});

it('activates the opened file when nothing else was selected meanwhile', async () => {
    installTabs(['/project/long.ts', '/project/short.ts'], 0);
    mocks.request.mockImplementation((method) =>
        method === 'files.read'
            ? Promise.resolve({ content: 'short', mtimeMs: 1, path: '/project/short.ts', size: 5 })
            : Promise.resolve(null),
    );

    await expect(openFileForSession('session-1', '/project/short.ts')).resolves.toBe(
        '/project/short.ts',
    );
    expect(activeTabId()).toBe('tab-1');
});

it('keeps a Settings tab opened by a shortcut while an earlier file open was still reading', async () => {
    installTabs(['/project/long.ts', '/project/short.ts'], 0);
    const read = Promise.withResolvers<unknown>();
    mocks.request.mockImplementation((method) =>
        method === 'files.read' ? read.promise : Promise.resolve(null),
    );

    const opening = openFileForSession('session-1', '/project/short.ts');
    openEditorTab(settingsTabPath());
    read.resolve({ content: 'short', mtimeMs: 1, path: '/project/short.ts', size: 5 });

    await expect(opening).resolves.toBe(false);
    expect(activeTabPath()).toBe(settingsTabPath());
});

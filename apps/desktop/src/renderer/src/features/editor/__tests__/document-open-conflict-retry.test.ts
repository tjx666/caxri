import type { BootstrapState } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() =>
    vi.fn<(...arguments_: unknown[]) => Promise<unknown>>(() => Promise.resolve(null)),
);

vi.mock('../../../lib/caxri', () => ({ caxri: { request } }));
vi.mock('../editor-reveal', () => ({
    focusEditor: vi.fn(),
    queueEditorNavigation: vi.fn(),
    revealEditorNavigation: vi.fn(),
}));

import { useSessionViewStore } from '../../../stores/session-view';
import { useWorkbenchStore } from '../../../stores/workbench';
import { openEditorTab } from '../document-commands';

function installEmptySession(): void {
    useWorkbenchStore.setState({
        bootstrap: {
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
                        root: { type: 'pane', id: 'pane-1', tabs: [] },
                        activePaneId: 'pane-1',
                    },
                },
            ],
            terminals: [],
        } as unknown as BootstrapState,
    });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
}

function paneTabPaths(): string[] {
    const pane = useWorkbenchStore.getState().bootstrap!.sessionStates[0].paneLayout.root;
    if (pane.type !== 'pane') throw new Error('Expected a single-pane layout');
    return pane.tabs.map((tab) =>
        tab.resource.kind === 'file' ? tab.resource.path : tab.resource.terminalId,
    );
}

afterEach(() => {
    request.mockReset();
    request.mockResolvedValue(null);
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
});

/**
 * Regression coverage for issue #1409: a brand-new Session's very first `session.updateState` can lose a race against
 * that same Session's own initial Terminal-attach write and come back `CONFLICT` ("stale revision") even though nothing
 * the caller did was wrong. Opening a file must survive that benign race instead of silently dropping the tab — see
 * `persistOpenedEditorTab` in `document-commands.ts`.
 */
describe('opening a tab after a stale-revision conflict', () => {
    it('retries once and keeps the tab open', async () => {
        installEmptySession();
        const conflict = new CaxriError(
            'CONFLICT',
            'Session state was written from a stale revision',
        );
        let updateStateCalls = 0;
        request.mockImplementation((method) => {
            if (method === 'session.updateState') {
                updateStateCalls += 1;
                return updateStateCalls === 1 ? Promise.reject(conflict) : Promise.resolve(null);
            }
            if (method === 'app.bootstrap')
                // The refresh a lost revision race triggers reflects the write that actually won — the Session's own
                // initial Terminal attachment, in the real race this reproduces — with a bumped revision and, unlike
                // the caller's optimistic layout, no file tab yet.
                return Promise.resolve({
                    selectedSessionId: 'session-1',
                    sessions: [
                        {
                            id: 'session-1',
                            projectId: 'project-1',
                            workbenchProjectId: 'project-1',
                        },
                    ],
                    sessionStates: [
                        {
                            sessionId: 'session-1',
                            revision: 1,
                            workbenchProjectId: 'project-1',
                            desiredSecondarySidebarViewContainerId: 'caxri.files',
                            paneLayout: {
                                root: { type: 'pane', id: 'pane-1', tabs: [] },
                                activePaneId: 'pane-1',
                            },
                        },
                    ],
                    terminals: [],
                    settings: {
                        'notifications.worktreeFallback': true,
                        'notifications.agentRecovery': true,
                    },
                } as unknown as BootstrapState);
            return Promise.resolve(null);
        });

        openEditorTab('/project/second.ts');
        await vi.waitFor(() => expect(updateStateCalls).toBe(2));
        await Promise.resolve();

        expect(paneTabPaths()).toEqual(['/project/second.ts']);
    });

    it('does not retry a genuine, non-conflict failure', async () => {
        installEmptySession();
        let updateStateCalls = 0;
        request.mockImplementation((method) => {
            if (method === 'session.updateState') {
                updateStateCalls += 1;
                return Promise.reject(new Error('write rejected'));
            }
            return Promise.resolve(null);
        });

        openEditorTab('/project/second.ts');
        await vi.waitFor(() => expect(updateStateCalls).toBe(1));
        await Promise.resolve();
        await Promise.resolve();

        expect(updateStateCalls).toBe(1);
        expect(paneTabPaths()).toEqual([]);
    });
});

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
import { closeDocumentTabs, openEditorTab } from '../document-commands';

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

function firstTabId(): string {
    const pane = useWorkbenchStore.getState().bootstrap!.sessionStates[0].paneLayout.root;
    if (pane.type !== 'pane') throw new Error('Expected a single-pane layout');
    const tab = pane.tabs.at(0);
    if (!tab) throw new Error('Expected an open tab');
    return tab.id;
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
 * the caller did was wrong. Opening a file must survive that benign race instead of silently dropping the tab; see
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
                // The refresh a lost revision race triggers reflects the write that actually won (the Session's own
                // initial Terminal attachment, in the real race this reproduces) with a bumped revision and, unlike
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

    /**
     * A later command can supersede this attempt before the original write settles. `patchSessionState` never rolls
     * back a write that is no longer the latest attempt (`stores/workbench.ts`'s `isLatestAttempt` guard), so a genuine
     * failure on the original open leaves the pane layout looking exactly like a lost revision race would: the reason
     * the retry decision must come from `onStaleWrite`, not from comparing pane layouts.
     */
    it('does not reopen a tab a later close already superseded, even when the original open write fails', async () => {
        installEmptySession();
        let updateStateCalls = 0;
        const openWrite = Promise.withResolvers<unknown>();
        request.mockImplementation((method) => {
            if (method === 'session.updateState') {
                updateStateCalls += 1;
                // The first write is the open, held pending; every later write (the close) resolves immediately.
                return updateStateCalls === 1 ? openWrite.promise : Promise.resolve(null);
            }
            return Promise.resolve(null);
        });

        openEditorTab('/project/second.ts');
        expect(paneTabPaths()).toEqual(['/project/second.ts']);

        // `closeDocumentTabs` awaits its own dirty-file confirmation before it ever calls `patchSessionState`, and
        // per-session writes are chained: the close's send only goes out once the still-pending open settles. So the
        // close is applied optimistically here (the pane layout updates synchronously once its patch call fires) while
        // its own network send stays queued behind the open's.
        const closed = closeDocumentTabs([firstTabId()]);
        await Promise.resolve();
        await Promise.resolve();
        expect(paneTabPaths()).toEqual([]);
        expect(updateStateCalls).toBe(1);

        openWrite.reject(new Error('write rejected'));
        await closed;
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(updateStateCalls).toBe(2);
        expect(paneTabPaths()).toEqual([]);
    });

    /**
     * Two consecutive lost-revision races must still terminate after exactly one retry (two total persistence
     * attempts), never loop indefinitely.
     */
    it('gives up after one retry when the retry itself also loses the race', async () => {
        installEmptySession();
        const conflict = new CaxriError(
            'CONFLICT',
            'Session state was written from a stale revision',
        );
        let updateStateCalls = 0;
        request.mockImplementation((method) => {
            if (method === 'session.updateState') {
                updateStateCalls += 1;
                return Promise.reject(conflict);
            }
            if (method === 'app.bootstrap')
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
        await Promise.resolve();
        await Promise.resolve();

        expect(updateStateCalls).toBe(2);
    });

    /**
     * The Session can switch its Workbench Root while the original write is in flight; the Server's own "stale
     * Workbench Root" rejection also surfaces as `CONFLICT`. Retrying against a refreshed snapshot from a different
     * root would carry this file into a root it was never opened against, so the retry must bail instead.
     */
    it('does not retry into a different Workbench Root than the one this open targeted', async () => {
        installEmptySession();
        const conflict = new CaxriError(
            'CONFLICT',
            'Session state was written from a stale revision',
        );
        let updateStateCalls = 0;
        request.mockImplementation((method) => {
            if (method === 'session.updateState') {
                updateStateCalls += 1;
                return Promise.reject(conflict);
            }
            if (method === 'app.bootstrap')
                // The refreshed snapshot shows the same Session parked on a different Project's root.
                return Promise.resolve({
                    selectedSessionId: 'session-1',
                    sessions: [
                        {
                            id: 'session-1',
                            projectId: 'project-2',
                            workbenchProjectId: 'project-2',
                        },
                    ],
                    sessionStates: [
                        {
                            sessionId: 'session-1',
                            revision: 1,
                            workbenchProjectId: 'project-2',
                            desiredSecondarySidebarViewContainerId: 'caxri.files',
                            paneLayout: {
                                root: { type: 'pane', id: 'pane-2', tabs: [] },
                                activePaneId: 'pane-2',
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
        await vi.waitFor(() => expect(updateStateCalls).toBe(1));
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // No second `session.updateState` call: the root mismatch stopped the retry before it could open anything.
        expect(updateStateCalls).toBe(1);
        expect(useWorkbenchStore.getState().bootstrap!.sessionStates[0].workbenchProjectId).toBe(
            'project-2',
        );
    });
});

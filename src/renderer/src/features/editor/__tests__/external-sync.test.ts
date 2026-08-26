import type { BootstrapState, SessionState } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const state: { handler?: (event: unknown) => void } = {};
    return {
        state,
        onEvent: vi.fn((handler: (event: unknown) => void) => {
            state.handler = handler;
            return () => {};
        }),
        request: vi.fn((_method: unknown, parameters: unknown) =>
            Promise.resolve({
                path: (parameters as { path: string }).path,
                content: 'content',
                dirty: false,
                mtimeMs: 1,
                size: 7,
            }),
        ),
    };
});

vi.mock('../../../lib/caxri', () => ({ caxri: mocks }));

import { getSessionDocuments, useSessionViewStore } from '../../../stores/session-view';
import { useToastStore } from '../../../stores/toasts';
import { useWorkbenchStore } from '../../../stores/workbench';
import { useFileOperationStore } from '../../view-containers/resource-explorer/file-operation-state';
import { subscribeExternalDocumentSync } from '../external-sync';

const oldPath = '/project/old.ts';
const nextPath = '/project/new.ts';

function sessionState(
    sessionId: string,
    path: string,
    workbenchProjectId = 'project-1',
): SessionState {
    return {
        sessionId,
        workbenchProjectId,
        desiredSecondarySidebarViewContainerId: 'caxri.files',
        paneLayout: {
            root: {
                type: 'pane',
                id: 'pane-1',
                tabs: [{ id: `tab-${sessionId}`, resource: { kind: 'file', path } }],
                activeTabId: `tab-${sessionId}`,
            },
            activePaneId: 'pane-1',
        },
    };
}

beforeEach(() => {
    mocks.onEvent.mockClear();
    mocks.request.mockClear();
    useFileOperationStore.getState().clear();
    useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
    useWorkbenchStore.setState({
        bootstrap: {
            selectedSessionId: 'session-1',
            sessions: [
                {
                    id: 'session-1',
                    projectId: 'project-1',
                    workbenchProjectId: 'project-1',
                },
                {
                    id: 'session-2',
                    projectId: 'project-1',
                    workbenchProjectId: 'project-1',
                },
            ],
            sessionStates: [
                sessionState('session-1', '/project/first.ts'),
                sessionState('session-2', oldPath),
            ],
            terminals: [],
        } as unknown as BootstrapState,
    });
    useSessionViewStore.getState().cacheDocument('session-2', {
        path: oldPath,
        content: 'content',
        dirty: false,
        mtimeMs: 1,
        size: 7,
    });
});

afterEach(() => {
    useFileOperationStore.getState().clear();
    useWorkbenchStore.setState({ bootstrap: undefined });
    useToastStore.getState().dismiss();
});

describe('subscribeExternalDocumentSync', () => {
    it('preserves a dirty buffer when the same Session returns to its Workbench Root', () => {
        const worktreeProjectId = 'project-worktree';
        const worktreePath = '/worktree/draft.ts';
        useSessionViewStore.getState().cacheDocument(
            'session-1',
            {
                path: worktreePath,
                content: 'retained draft',
                dirty: true,
                mtimeMs: 1,
                size: 14,
            },
            worktreeProjectId,
        );
        const unsubscribe = subscribeExternalDocumentSync();

        useWorkbenchStore.setState((state) => ({
            bootstrap: {
                ...state.bootstrap!,
                sessions: state.bootstrap!.sessions.map((session) =>
                    session.id === 'session-1'
                        ? { ...session, workbenchProjectId: worktreeProjectId }
                        : session,
                ),
                sessionStates: state.bootstrap!.sessionStates.map((current) =>
                    current.sessionId === 'session-1'
                        ? sessionState('session-1', worktreePath, worktreeProjectId)
                        : current,
                ),
            },
        }));

        expect(mocks.request).not.toHaveBeenCalled();
        expect(
            useSessionViewStore.getState().documents[`session-1\0${worktreeProjectId}`]?.[
                worktreePath
            ],
        ).toMatchObject({ content: 'retained draft', dirty: true });
        unsubscribe();
    });

    it('defers a same-Project Session switch until the managed move remaps editor paths', () => {
        const unsubscribe = subscribeExternalDocumentSync();
        useFileOperationStore.getState().begin({
            id: 'move-1',
            label: 'Moving old.ts',
            projectId: 'project-1',
            affectedPaths: [oldPath],
        });

        useWorkbenchStore.setState((state) => ({
            bootstrap: { ...state.bootstrap!, selectedSessionId: 'session-2' },
        }));
        expect(mocks.request).not.toHaveBeenCalled();

        useSessionViewStore.getState().remapDocuments('session-2', oldPath, nextPath);
        useWorkbenchStore.setState((state) => ({
            bootstrap: {
                ...state.bootstrap!,
                sessionStates: state.bootstrap!.sessionStates.map((current) =>
                    current.sessionId === 'session-2'
                        ? sessionState('session-2', nextPath)
                        : current,
                ),
            },
        }));
        useFileOperationStore.getState().finish('move-1');

        expect(mocks.request).toHaveBeenCalledTimes(1);
        expect(mocks.request).toHaveBeenCalledWith('files.read', {
            sessionId: 'session-2',
            path: nextPath,
        });
        unsubscribe();
    });

    it('silently reloads a clean buffer after an external change', async () => {
        useSessionViewStore.getState().cacheDocument('session-1', {
            path: '/project/first.ts',
            content: 'cached content',
            dirty: false,
            mtimeMs: 1,
            size: 14,
        });
        mocks.request.mockImplementationOnce((_method, parameters) =>
            Promise.resolve({
                path: (parameters as { path: string }).path,
                content: 'disk content',
                dirty: false,
                mtimeMs: 2,
                size: 12,
            }),
        );
        const unsubscribe = subscribeExternalDocumentSync();

        mocks.state.handler?.({
            event: 'files.changed',
            payload: {
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
                overflow: false,
                changes: [{ kind: 'update', path: '/project/first.ts' }],
            },
        });

        await vi.waitFor(() => {
            expect(
                getSessionDocuments('session-1', 'project-1')?.['/project/first.ts'],
            ).toMatchObject({ content: 'disk content', dirty: false });
        });
        expect(useToastStore.getState().toasts).toEqual([]);
        unsubscribe();
    });

    it('keeps the external-reload notice on screen because it can discard unsaved work', async () => {
        useSessionViewStore.getState().cacheDocument('session-1', {
            path: '/project/first.ts',
            content: 'dirty content',
            dirty: true,
            mtimeMs: 1,
            size: 7,
        });
        mocks.request.mockImplementationOnce((_method, parameters) =>
            Promise.resolve({
                path: (parameters as { path: string }).path,
                content: 'disk content',
                dirty: false,
                mtimeMs: 2,
                size: 12,
            }),
        );
        const unsubscribe = subscribeExternalDocumentSync();

        mocks.state.handler?.({
            event: 'files.changed',
            payload: {
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
                overflow: false,
                changes: [{ kind: 'update', path: '/project/first.ts' }],
            },
        });

        await vi.waitFor(() => {
            expect(useToastStore.getState().toasts).toContainEqual(
                expect.objectContaining({ kind: 'info', persist: true }),
            );
        });
        unsubscribe();
    });

    it('reports only discarded dirty buffers when a mixed batch reloads', async () => {
        const paths = ['/project/first.ts', '/project/second.ts', '/project/third.ts'] as const;
        useWorkbenchStore.setState((state) => ({
            bootstrap: {
                ...state.bootstrap!,
                sessionStates: state.bootstrap!.sessionStates.map((current) =>
                    current.sessionId === 'session-1'
                        ? {
                              ...current,
                              paneLayout: {
                                  root: {
                                      type: 'pane',
                                      id: 'pane-1',
                                      tabs: paths.map((path) => ({
                                          id: `tab-${path}`,
                                          resource: { kind: 'file', path },
                                      })),
                                      activeTabId: `tab-${paths[0]}`,
                                  },
                                  activePaneId: 'pane-1',
                              },
                          }
                        : current,
                ),
            },
        }));
        for (const [index, path] of paths.entries()) {
            useSessionViewStore.getState().cacheDocument('session-1', {
                path,
                content: 'cached content',
                dirty: index < 2,
                mtimeMs: 1,
                size: 14,
            });
            mocks.request.mockImplementationOnce(() =>
                Promise.resolve({
                    path,
                    content: 'disk content',
                    dirty: false,
                    mtimeMs: 2,
                    size: 12,
                }),
            );
        }
        const unsubscribe = subscribeExternalDocumentSync();

        mocks.state.handler?.({
            event: 'files.changed',
            payload: {
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
                overflow: false,
                changes: paths.map((path) => ({ kind: 'update', path })),
            },
        });

        await vi.waitFor(() => {
            expect(useToastStore.getState().toasts).toEqual([
                expect.objectContaining({
                    kind: 'info',
                    message: '2 open files reloaded from disk; external changes take precedence.',
                    persist: true,
                }),
            ]);
        });
        for (const path of paths)
            expect(getSessionDocuments('session-1', 'project-1')?.[path]).toMatchObject({
                content: 'disk content',
                dirty: false,
            });
        unsubscribe();
    });

    it('silently reconciles a clean buffer after selecting its Session', async () => {
        mocks.request.mockImplementationOnce((_method, parameters) =>
            Promise.resolve({
                path: (parameters as { path: string }).path,
                content: 'reconciled content',
                dirty: false,
                mtimeMs: 2,
                size: 18,
            }),
        );
        const unsubscribe = subscribeExternalDocumentSync();

        useWorkbenchStore.setState((state) => ({
            bootstrap: { ...state.bootstrap!, selectedSessionId: 'session-2' },
        }));

        await vi.waitFor(() => {
            expect(getSessionDocuments('session-2', 'project-1')?.[oldPath]).toMatchObject({
                content: 'reconciled content',
                dirty: false,
            });
        });
        expect(useToastStore.getState().toasts).toEqual([]);
        unsubscribe();
    });

    it('reconciles the selected sibling Session when its Workbench Project changes on disk', async () => {
        useWorkbenchStore.setState((state) => ({
            bootstrap: { ...state.bootstrap!, selectedSessionId: 'session-2' },
        }));
        mocks.request.mockImplementationOnce((_method, parameters) =>
            Promise.resolve({
                path: (parameters as { path: string }).path,
                content: 'disk content',
                dirty: false,
                mtimeMs: 2,
                size: 12,
            }),
        );
        const unsubscribe = subscribeExternalDocumentSync();

        mocks.state.handler?.({
            event: 'files.changed',
            payload: {
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
                overflow: false,
                changes: [{ kind: 'update', path: oldPath }],
            },
        });

        await vi.waitFor(() =>
            expect(mocks.request).toHaveBeenCalledWith('files.read', {
                sessionId: 'session-2',
                path: oldPath,
            }),
        );
        unsubscribe();
    });
});

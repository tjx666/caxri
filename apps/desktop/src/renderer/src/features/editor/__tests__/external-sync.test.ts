import type { BootstrapState, SessionState } from '@caxri/protocol';
import { externalEditorTabPath } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const state: { handler?: (event: unknown) => void } = {};
    return {
        state,
        onEvent: vi.fn((handler: (event: unknown) => void) => {
            state.handler = handler;
            return () => {};
        }),
        request: vi.fn((_method: unknown, parameters: unknown): Promise<unknown> =>
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
import { dismissToast, getToasts } from '../../../stores/toasts';
import { useWorkbenchStore } from '../../../stores/workbench';
import { useFileOperationStore } from '../../view-containers/resource-explorer/file-operation-state';
import { clearDiscardedBuffers, discardedChangesUnavailableReason } from '../discarded-buffers';
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
        revision: 0,
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
    clearDiscardedBuffers();
    useFileOperationStore.getState().clear();
    useWorkbenchStore.setState({ bootstrap: undefined });
    dismissToast();
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
        expect(getToasts()).toEqual([]);
        unsubscribe();
    });

    it('rechecks every open document after watcher overflow', async () => {
        const paths = ['/project/first.ts', '/project/second.ts'] as const;
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
        for (const path of paths)
            useSessionViewStore.getState().cacheDocument('session-1', {
                path,
                content: 'cached content',
                dirty: false,
                mtimeMs: 1,
                size: 14,
            });
        for (const path of paths)
            mocks.request.mockImplementationOnce(() =>
                Promise.resolve({
                    path,
                    content: `disk content for ${path}`,
                    dirty: false,
                    mtimeMs: 2,
                    size: 20,
                }),
            );
        const unsubscribe = subscribeExternalDocumentSync();

        mocks.state.handler?.({
            event: 'files.changed',
            payload: {
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
                overflow: true,
                changes: [{ kind: 'update', path: paths[0] }],
            },
        });

        await vi.waitFor(() => {
            expect(mocks.request).toHaveBeenCalledTimes(2);
            for (const path of paths)
                expect(getSessionDocuments('session-1', 'project-1')?.[path]).toMatchObject({
                    content: `disk content for ${path}`,
                    dirty: false,
                });
        });
        for (const path of paths) {
            expect(mocks.request).toHaveBeenCalledWith('files.read', {
                sessionId: 'session-1',
                path,
            });
        }
        unsubscribe();
    });

    it('warns about a discarded buffer and offers to restore it', async () => {
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
            expect(getToasts()).toContainEqual(
                expect.objectContaining({
                    type: 'warning',
                    title: 'Your unsaved changes to first.ts were replaced by changes on disk.',
                    duration: Infinity,
                }),
            );
        });
        // What the action restores is covered by `discarded-buffers.test.ts`; here the stash must be ready for it.
        expect(
            discardedChangesUnavailableReason({
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
                paths: ['/project/first.ts'],
            }),
        ).toBeUndefined();
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
            expect(getToasts()).toEqual([
                expect.objectContaining({
                    type: 'warning',
                    title: 'Your unsaved changes to 2 files were replaced by changes on disk.',
                    duration: Infinity,
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
        expect(getToasts()).toEqual([]);
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

    describe('external documents', () => {
        const externalPath = externalEditorTabPath('doc-1', 'notes.md');

        function cacheExternal(content: string, isDirty: boolean): void {
            useSessionViewStore.getState().cacheDocument('session-1', {
                path: externalPath,
                content,
                dirty: isDirty,
                mtimeMs: 1,
                size: content.length,
                ephemeral: true,
                displayPath: '/tmp/notes.md',
            });
        }

        function answerExternalRead(content: string, mtimeMs = 2): void {
            mocks.request.mockImplementation((method: unknown) =>
                method === 'externalDocument.read'
                    ? Promise.resolve({ content, mtimeMs, size: content.length })
                    : Promise.resolve(null),
            );
        }

        afterEach(() => {
            mocks.request.mockReset();
        });

        it('asks Main to watch the open external documents and stops when they close', () => {
            answerExternalRead('unused');
            cacheExternal('# Notes', false);
            const unsubscribe = subscribeExternalDocumentSync();

            expect(mocks.request).toHaveBeenCalledWith('externalDocument.watch', {
                documentIds: ['doc-1'],
            });
            useSessionViewStore.getState().evictDocument('session-1', externalPath);
            expect(mocks.request).toHaveBeenLastCalledWith('externalDocument.watch', {
                documentIds: [],
            });
            unsubscribe();
        });

        it('silently reloads a clean external buffer another app changed', async () => {
            answerExternalRead('# Notes from disk');
            cacheExternal('# Notes', false);
            const unsubscribe = subscribeExternalDocumentSync();

            mocks.state.handler?.({
                event: 'externalDocument.changed',
                payload: { documentId: 'doc-1' },
            });

            await vi.waitFor(() => {
                expect(getSessionDocuments('session-1', 'project-1')?.[externalPath]).toMatchObject(
                    {
                        content: '# Notes from disk',
                        dirty: false,
                        ephemeral: true,
                        displayPath: '/tmp/notes.md',
                    },
                );
            });
            expect(mocks.request).toHaveBeenCalledWith('externalDocument.read', {
                documentId: 'doc-1',
            });
            expect(getToasts()).toEqual([]);
            unsubscribe();
        });

        it('lets the disk win over unsaved edits and names the file in the lasting notice', async () => {
            answerExternalRead('# Notes from disk');
            cacheExternal('# Unsaved draft', true);
            const unsubscribe = subscribeExternalDocumentSync();

            mocks.state.handler?.({
                event: 'externalDocument.changed',
                payload: { documentId: 'doc-1' },
            });

            await vi.waitFor(() => {
                expect(getToasts()).toContainEqual(
                    expect.objectContaining({
                        title: 'Your unsaved changes to notes.md were replaced by changes on disk.',
                        duration: Infinity,
                    }),
                );
            });
            expect(getSessionDocuments('session-1', 'project-1')?.[externalPath]?.content).toBe(
                '# Notes from disk',
            );
            unsubscribe();
        });

        it('keeps the buffer when the read finds nothing new or fails', async () => {
            answerExternalRead('# Notes', 1);
            cacheExternal('# Notes', false);
            const unsubscribe = subscribeExternalDocumentSync();

            mocks.state.handler?.({
                event: 'externalDocument.changed',
                payload: { documentId: 'doc-1' },
            });
            mocks.request.mockImplementation(() => Promise.reject(new Error('gone')));
            mocks.state.handler?.({
                event: 'externalDocument.changed',
                payload: { documentId: 'doc-1' },
            });

            await vi.waitFor(() => {
                expect(mocks.request).toHaveBeenCalledWith('externalDocument.read', {
                    documentId: 'doc-1',
                });
            });
            expect(getSessionDocuments('session-1', 'project-1')?.[externalPath]?.content).toBe(
                '# Notes',
            );
            expect(getToasts()).toEqual([]);
            unsubscribe();
        });
    });
});

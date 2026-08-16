import type { BootstrapState, SessionState } from '@shared/types';
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

vi.mock('../../lib/caxri', () => ({ caxri: mocks }));

import { useSessionViewStore } from '../../stores/session-view';
import { useToastStore } from '../../stores/toasts';
import { useWorkbenchStore } from '../../stores/workbench';
import { useFileOperationStore } from '../inspector/panels/files/file-operation-state';
import { subscribeExternalDocumentSync } from './external-sync';

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
        openTabs: [{ path, dirty: false }],
        activeTab: { kind: 'editor', path },
        inspectorMode: 'files',
        layout: {},
    };
}

beforeEach(() => {
    mocks.onEvent.mockClear();
    mocks.request.mockClear();
    useFileOperationStore.getState().clear();
    useSessionViewStore.setState({ activeWork: {}, documents: {}, recentDocuments: {} });
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

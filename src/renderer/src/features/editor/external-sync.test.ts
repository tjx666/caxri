import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BootstrapState, SessionState } from '@shared/types';

const mocks = vi.hoisted(() => ({
    onEvent: vi.fn(() => () => undefined),
    request: vi.fn((_method: unknown, params: unknown) =>
        Promise.resolve({
            path: (params as { path: string }).path,
            content: 'content',
            dirty: false,
            mtimeMs: 1,
            size: 7,
        }),
    ),
}));

vi.mock('../../lib/caxri', () => ({ caxri: mocks }));

import { useSessionViewStore } from '../../stores/session-view';
import { useWorkbenchStore } from '../../stores/workbench';
import { useFileOperationStore } from '../inspector/panels/files/file-operation-state';
import { subscribeExternalDocumentSync } from './external-sync';

const oldPath = '/project/old.ts';
const nextPath = '/project/new.ts';

function sessionState(sessionId: string, path: string): SessionState {
    return {
        sessionId,
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
                { id: 'session-1', projectId: 'project-1' },
                { id: 'session-2', projectId: 'project-1' },
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
});

describe('subscribeExternalDocumentSync', () => {
    it('defers a same-Project Session switch until the managed move remaps editor paths', () => {
        const unsubscribe = subscribeExternalDocumentSync();
        useFileOperationStore.getState().begin({
            id: 'move-1',
            label: 'Moving old.ts',
            projectId: 'project-1',
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
});

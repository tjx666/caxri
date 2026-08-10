import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BootstrapState, SessionState } from '@shared/types';

const mocks = vi.hoisted(() => ({
    request: vi.fn((method: unknown, params?: unknown): Promise<unknown> => {
        void method;
        void params;
        return Promise.resolve(null);
    }),
}));

vi.mock('../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { useSessionViewStore } from '../../stores/session-view';
import { useWorkbenchStore } from '../../stores/workbench';
import {
    changeDocument,
    closeOpenEditorsUnderPath,
    openFile,
    remapOpenEditors,
    saveActiveEditor,
} from './document-actions';

const sessionState = (sessionId: string, path: string): SessionState => ({
    sessionId,
    openTabs: [{ path, dirty: true }],
    activeTab: { kind: 'editor', path },
    inspectorMode: 'files',
    layout: {},
});

function installSessions(originPath: string, selectedSessionId = 'session-2'): void {
    useWorkbenchStore.setState({
        bootstrap: {
            selectedSessionId,
            sessions: [{ id: 'session-1' }, { id: 'session-2' }],
            sessionStates: [
                sessionState('session-1', originPath),
                sessionState('session-2', '/other/session.ts'),
            ],
            terminals: [],
        } as unknown as BootstrapState,
    });
    useSessionViewStore.setState({ activeWork: {}, documents: {}, recentDocuments: {} });
    useSessionViewStore.getState().cacheDocument('session-1', {
        path: originPath,
        content: 'unsaved',
        dirty: true,
        mtimeMs: 1,
        size: 7,
    });
    useSessionViewStore.getState().setActiveWork('session-1', { kind: 'editor', path: originPath });
}

function installEmptySession(): void {
    useWorkbenchStore.setState({
        bootstrap: {
            selectedSessionId: 'session-1',
            sessions: [{ id: 'session-1' }],
            sessionStates: [
                {
                    sessionId: 'session-1',
                    openTabs: [],
                    inspectorMode: 'files',
                    layout: {},
                },
            ],
            terminals: [],
        } as unknown as BootstrapState,
    });
    useSessionViewStore.setState({ activeWork: {}, documents: {}, recentDocuments: {} });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

afterEach(() => {
    mocks.request.mockClear();
    useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
    useSessionViewStore.setState({ activeWork: {}, documents: {}, recentDocuments: {} });
});

describe('session-scoped file mutation completion', () => {
    it('remaps the origin Session after the user selected another Session', () => {
        installSessions('/project/source.ts');

        remapOpenEditors('session-1', '/project/source.ts', '/project/renamed.ts');

        const states = useWorkbenchStore.getState().bootstrap?.sessionStates ?? [];
        expect(states.find((state) => state.sessionId === 'session-1')).toMatchObject({
            activeTab: { kind: 'editor', path: '/project/renamed.ts' },
            openTabs: [{ path: '/project/renamed.ts', dirty: true }],
        });
        expect(states.find((state) => state.sessionId === 'session-2')?.openTabs).toEqual([
            { path: '/other/session.ts', dirty: true },
        ]);
        expect(useSessionViewStore.getState().documents['session-1']).toMatchObject({
            '/project/renamed.ts': { content: 'unsaved', dirty: true },
        });
    });

    it('closes only the origin Session tab after Trash confirmation returns', () => {
        installSessions('/project/trashed.ts');

        closeOpenEditorsUnderPath('session-1', '/project/trashed.ts');

        const states = useWorkbenchStore.getState().bootstrap?.sessionStates ?? [];
        expect(states.find((state) => state.sessionId === 'session-1')).toMatchObject({
            activeTab: undefined,
            openTabs: [],
        });
        expect(states.find((state) => state.sessionId === 'session-2')?.openTabs).toEqual([
            { path: '/other/session.ts', dirty: true },
        ]);
        expect(useSessionViewStore.getState().documents['session-1']).toEqual({});
    });

    it('remaps a file read that completes after the file moved', async () => {
        installEmptySession();
        const read = deferred<{ content: string; mtimeMs: number; path: string; size: number }>();
        mocks.request.mockReturnValueOnce(read.promise);

        const opening = openFile('/project/source.ts');
        remapOpenEditors('session-1', '/project/source.ts', '/project/renamed.ts');
        read.resolve({ content: 'disk', mtimeMs: 1, path: '/project/source.ts', size: 4 });

        await expect(opening).resolves.toBe('/project/renamed.ts');
        const documents = useSessionViewStore.getState().documents['session-1'];
        expect(Object.keys(documents ?? {})).toEqual(['/project/renamed.ts']);
        expect(documents?.['/project/renamed.ts']).toMatchObject({ content: 'disk', dirty: false });
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates[0].openTabs).toEqual([
            expect.objectContaining({ path: '/project/renamed.ts' }),
        ]);
    });

    it('discards a file read that completes after the file moved to Trash', async () => {
        installEmptySession();
        const read = deferred<{ content: string; mtimeMs: number; path: string; size: number }>();
        mocks.request.mockReturnValueOnce(read.promise);

        const opening = openFile('/project/trashed.ts');
        closeOpenEditorsUnderPath('session-1', '/project/trashed.ts');
        read.resolve({ content: 'disk', mtimeMs: 1, path: '/project/trashed.ts', size: 4 });

        await expect(opening).resolves.toBe(false);
        expect(useSessionViewStore.getState().documents['session-1']).toBeUndefined();
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates[0].openTabs).toEqual([]);
    });

    it('keeps newer dirty content when a save completes after the file moved', async () => {
        installSessions('/project/source.ts', 'session-1');
        const write = deferred<{ content: string; mtimeMs: number; path: string; size: number }>();
        mocks.request.mockReturnValueOnce(write.promise);

        const saving = saveActiveEditor();
        remapOpenEditors('session-1', '/project/source.ts', '/project/renamed.ts');
        changeDocument('/project/renamed.ts', 'newer unsaved');
        write.resolve({ content: 'unsaved', mtimeMs: 2, path: '/project/source.ts', size: 7 });
        await saving;

        const documents = useSessionViewStore.getState().documents['session-1'];
        expect(Object.keys(documents ?? {})).toEqual(['/project/renamed.ts']);
        expect(documents?.['/project/renamed.ts']).toMatchObject({
            content: 'newer unsaved',
            dirty: true,
            mtimeMs: 2,
        });
        expect(useWorkbenchStore.getState().bootstrap?.sessionStates[0].openTabs).toEqual([
            { path: '/project/renamed.ts', dirty: true },
        ]);
    });
});

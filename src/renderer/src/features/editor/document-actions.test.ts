import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BootstrapState, SessionState } from '@shared/types';

const mocks = vi.hoisted(() => ({ request: vi.fn(() => Promise.resolve(null)) }));

vi.mock('../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { useSessionViewStore } from '../../stores/session-view';
import { useWorkbenchStore } from '../../stores/workbench';
import { closeOpenEditorsUnderPath, remapOpenEditors } from './document-actions';

const sessionState = (sessionId: string, path: string): SessionState => ({
    sessionId,
    openTabs: [{ path, dirty: true }],
    activeTab: { kind: 'editor', path },
    inspectorMode: 'files',
    layout: {},
});

function installSessions(originPath: string): void {
    useWorkbenchStore.setState({
        bootstrap: {
            selectedSessionId: 'session-2',
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
});

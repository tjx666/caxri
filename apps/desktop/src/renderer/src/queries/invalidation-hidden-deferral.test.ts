import type { BootstrapState, ServerEvent } from '@caxri/protocol';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const state: { handler?: (event: ServerEvent) => void } = {};
    return {
        state,
        onEvent: vi.fn((handler: (event: ServerEvent) => void) => {
            state.handler = handler;
            return () => {};
        }),
    };
});

vi.mock('../lib/caxri', () => ({ caxri: mocks }));

import { useWorkbenchStore } from '../stores/workbench';
import { caxriQueryKey } from './client';
import { subscribeRuntimeQueryInvalidation } from './invalidation';

class FakeDocument extends EventTarget {
    visibilityState: DocumentVisibilityState = 'visible';

    show(state: DocumentVisibilityState): void {
        this.visibilityState = state;
        this.dispatchEvent(new Event('visibilitychange'));
    }
}

const LIST_KEY = caxriQueryKey('files.list', { sessionId: 'session-a', directory: '/project' });
const BADGE_KEY = [
    'viewContainers.viewOperation',
    {
        viewId: 'git.view',
        operation: 'badge.snapshot',
        contextKey: 'session-a:project-a',
        arguments: {},
    },
];

async function mount(queryClient: QueryClient, queryKey: readonly unknown[]) {
    const queryFunction = vi.fn(() => Promise.resolve({}));
    const observer = new QueryObserver(queryClient, { queryKey, queryFn: queryFunction });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(queryFunction).toHaveBeenCalledTimes(1));
    return { queryFunction, unsubscribe };
}

function filesChanged(path: string): void {
    mocks.state.handler?.({
        event: 'files.changed',
        payload: {
            sessionId: 'session-a',
            workbenchRootProjectId: 'project-a',
            overflow: false,
            changes: [{ path, kind: 'update' }],
        },
    });
}

function badgeChanged(): void {
    mocks.state.handler?.({
        event: 'viewContainers.viewChanged',
        payload: {
            viewId: 'git.view',
            eventId: 'badge-change',
            extensionGeneration: 1,
            context: {
                kind: 'session',
                sessionId: 'session-a',
                workbenchRootProjectId: 'project-a',
            },
            change: { kind: 'badge' },
        },
    });
}

describe('file and view invalidation while the window is hidden', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        useWorkbenchStore.setState({ bootstrap: undefined });
    });

    it('defers file tree listings until the window shows again', async () => {
        const fakeDocument = new FakeDocument();
        vi.stubGlobal('document', fakeDocument);
        useWorkbenchStore.setState({
            bootstrap: {
                sessions: [{ id: 'session-a', workbenchRootProjectId: 'project-a' }],
                sessionStates: [],
                terminals: [],
            } as unknown as BootstrapState,
        });
        const queryClient = new QueryClient();
        const listing = await mount(queryClient, LIST_KEY);
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        fakeDocument.show('hidden');
        filesChanged('/project/a.ts');
        await vi.waitFor(() =>
            expect(queryClient.getQueryState(LIST_KEY)?.isInvalidated).toBe(true),
        );
        filesChanged('/project/b.ts');
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(listing.queryFunction).toHaveBeenCalledTimes(1);

        fakeDocument.show('visible');
        await vi.waitFor(() => expect(listing.queryFunction).toHaveBeenCalledTimes(2));
        fakeDocument.show('hidden');
        fakeDocument.show('visible');
        await Promise.resolve();
        expect(listing.queryFunction).toHaveBeenCalledTimes(2);
        unsubscribe();
        listing.unsubscribe();
    });

    it('defers Source Control badge reads until the window shows again', async () => {
        const fakeDocument = new FakeDocument();
        vi.stubGlobal('document', fakeDocument);
        const queryClient = new QueryClient();
        const badge = await mount(queryClient, BADGE_KEY);
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        fakeDocument.show('hidden');
        badgeChanged();
        badgeChanged();
        await Promise.resolve();
        expect(queryClient.getQueryState(BADGE_KEY)?.isInvalidated).toBe(true);
        expect(badge.queryFunction).toHaveBeenCalledTimes(1);

        fakeDocument.show('visible');
        await vi.waitFor(() => expect(badge.queryFunction).toHaveBeenCalledTimes(2));
        unsubscribe();
        badge.unsubscribe();
    });

    it('still refreshes badges immediately while the window is visible', async () => {
        vi.stubGlobal('document', new FakeDocument());
        const queryClient = new QueryClient();
        const badge = await mount(queryClient, BADGE_KEY);
        const unsubscribe = subscribeRuntimeQueryInvalidation(queryClient);

        badgeChanged();
        await vi.waitFor(() => expect(badge.queryFunction).toHaveBeenCalledTimes(2));
        unsubscribe();
        badge.unsubscribe();
    });
});

import type { BootstrapState } from '@shared/types';
import type { ViewCatalogSnapshot } from '@shared/views';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn<(method: string, parameters?: unknown) => Promise<unknown>>(() =>
        Promise.resolve({}),
    ),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { caxriQueryKey, queryClient } from '../../../queries/client';
import { useChromeLayoutStore } from '../../../stores/chrome-layout';
import { useToastStore } from '../../../stores/toasts';
import { useWorkbenchStore } from '../../../stores/workbench';
import {
    didExecuteViewCatalogCommand,
    executeViewCatalogShortcut,
} from '../view-container-commands';

function catalog(): ViewCatalogSnapshot {
    return {
        revision: 1,
        containers: [
            {
                id: 'publisher.fixture',
                location: 'secondarySidebar',
                source: { kind: 'extension', extensionId: 'publisher.fixture' },
                title: 'Fixture',
                icon: { kind: 'builtin', id: 'beaker' },
                commandId: 'viewContainers.show.publisher.fixture',
                lifecycle: 'active',
            },
        ],
        views: [],
        commands: [
            {
                id: 'viewContainers.show.publisher.fixture',
                title: 'Show Fixture',
                source: { kind: 'extension', extensionId: 'publisher.fixture' },
                lifecycle: 'active',
            },
            {
                id: 'publisher.fixture.refresh',
                title: 'Refresh Fixture',
                source: { kind: 'extension', extensionId: 'publisher.fixture' },
                lifecycle: 'active',
            },
        ],
        extensions: [],
    };
}

beforeEach(() => {
    mocks.request.mockClear();
    mocks.request.mockResolvedValue({});
    queryClient.clear();
    useChromeLayoutStore.setState({ secondarySidebarVisible: false });
    useToastStore.setState({ toasts: [] });
    useWorkbenchStore.setState({
        bootstrap: {
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
                    workbenchProjectId: 'project-1',
                    desiredSecondarySidebarViewContainerId: 'caxri.files',
                    paneLayout: {},
                },
            ],
        } as unknown as BootstrapState,
    });
});

describe('didExecuteViewCatalogCommand', () => {
    it('dispatches an extension-owned command through IPC exactly once', async () => {
        const handled = didExecuteViewCatalogCommand(catalog(), 'publisher.fixture.refresh', [
            'manual',
        ]);

        expect(handled).toBe(true);
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
        expect(mocks.request).toHaveBeenCalledWith('viewContainers.executeCommand', {
            commandId: 'publisher.fixture.refresh',
            arguments: ['manual'],
        });
    });

    it('reveals an extension container locally without invoking extension code', () => {
        expect(
            didExecuteViewCatalogCommand(catalog(), 'viewContainers.show.publisher.fixture'),
        ).toBe(true);

        expect(useChromeLayoutStore.getState().secondarySidebarVisible).toBe(true);
        expect(
            useWorkbenchStore.getState().bootstrap?.sessionStates[0]
                ?.desiredSecondarySidebarViewContainerId,
        ).toBe('publisher.fixture');
        expect(mocks.request).toHaveBeenCalledExactlyOnceWith('session.updateState', {
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'publisher.fixture',
            paneLayout: {},
        });
    });

    it('falls through for an unknown command', () => {
        expect(didExecuteViewCatalogCommand(catalog(), 'publisher.fixture.unknown')).toBe(false);
        expect(mocks.request).not.toHaveBeenCalled();
    });

    it('reports command failures through the shared toast path', async () => {
        mocks.request.mockRejectedValueOnce(new Error('fixture failed'));

        didExecuteViewCatalogCommand(catalog(), 'publisher.fixture.refresh');

        await vi.waitFor(() =>
            expect(useToastStore.getState().toasts).toEqual([
                expect.objectContaining({ kind: 'error', message: 'fixture failed' }),
            ]),
        );
    });

    it('loads a missing catalog before dispatching a shortcut exactly once', async () => {
        mocks.request.mockImplementation((method) =>
            Promise.resolve(method === 'viewContainers.catalog' ? catalog() : {}),
        );

        await executeViewCatalogShortcut('publisher.fixture.refresh', ['shortcut']);

        expect(mocks.request.mock.calls).toEqual([
            ['viewContainers.catalog', {}],
            [
                'viewContainers.executeCommand',
                {
                    commandId: 'publisher.fixture.refresh',
                    arguments: ['shortcut'],
                },
            ],
        ]);
    });

    it('reloads an invalidated catalog before resolving a newly contributed shortcut', async () => {
        queryClient.setQueryData(caxriQueryKey('viewContainers.catalog', {}), {
            ...catalog(),
            commands: [],
        });
        await queryClient.invalidateQueries({
            queryKey: caxriQueryKey('viewContainers.catalog', {}),
            refetchType: 'none',
        });
        mocks.request.mockImplementation((method) =>
            Promise.resolve(method === 'viewContainers.catalog' ? catalog() : {}),
        );

        await executeViewCatalogShortcut('publisher.fixture.refresh');

        expect(mocks.request).toHaveBeenCalledWith('viewContainers.catalog', {});
        expect(mocks.request).toHaveBeenCalledWith('viewContainers.executeCommand', {
            commandId: 'publisher.fixture.refresh',
            arguments: [],
        });
    });

    it('reports a shortcut whose command is absent from the current catalog', async () => {
        mocks.request.mockResolvedValueOnce(catalog());

        await executeViewCatalogShortcut('publisher.fixture.unknown');

        expect(useToastStore.getState().toasts).toEqual([
            expect.objectContaining({
                kind: 'error',
                message: 'Unknown command: publisher.fixture.unknown',
            }),
        ]);
    });
});

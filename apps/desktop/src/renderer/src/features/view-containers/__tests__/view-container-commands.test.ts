import type { BootstrapState, ViewCatalogSnapshot } from '@caxri/protocol';
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
    dispatchExtensionViewAction,
    executeEditableViewCatalogShortcut,
    executeViewCatalogShortcut,
    getCachedViewCatalogCommandAllowedInEditable,
    isCachedViewCatalogCommandAllowedInEditable,
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
        views: [
            {
                id: 'publisher.fixture.view',
                containerId: 'publisher.fixture',
                source: { kind: 'extension', extensionId: 'publisher.fixture' },
                title: 'Fixture',
                viewKind: { kind: 'resource-explorer' },
                actions: [
                    {
                        commandId: 'publisher.fixture.refresh',
                        role: 'resource.refresh',
                    },
                ],
            },
        ],
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
                allowInEditable: true,
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
        await vi.waitFor(() =>
            expect(mocks.request).toHaveBeenCalledWith('viewContainers.executeCommand', {
                commandId: 'publisher.fixture.refresh',
                arguments: ['manual'],
            }),
        );
        expect(useChromeLayoutStore.getState().secondarySidebarVisible).toBe(true);
        expect(
            useWorkbenchStore.getState().bootstrap?.sessionStates[0]
                ?.desiredSecondarySidebarViewContainerId,
        ).toBe('publisher.fixture');
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

    it('reads editable-focus policy from the current manifest catalog', () => {
        queryClient.setQueryData(caxriQueryKey('viewContainers.catalog', {}), catalog());

        expect(isCachedViewCatalogCommandAllowedInEditable('publisher.fixture.refresh')).toBe(true);
        expect(isCachedViewCatalogCommandAllowedInEditable('publisher.fixture.unknown')).toBe(
            false,
        );
    });

    it('reports a cold catalog as unknown until the manifest lookup completes', () => {
        expect(getCachedViewCatalogCommandAllowedInEditable('publisher.fixture.refresh')).toBe(
            undefined,
        );
    });

    it('dispatches a cold editable shortcut only after the manifest opts it in', async () => {
        mocks.request.mockImplementation((method) =>
            Promise.resolve(method === 'viewContainers.catalog' ? catalog() : {}),
        );

        await executeEditableViewCatalogShortcut('publisher.fixture.refresh', ['editable']);

        expect(mocks.request).toHaveBeenCalledWith('viewContainers.executeCommand', {
            commandId: 'publisher.fixture.refresh',
            arguments: ['editable'],
        });
    });

    it('fails closed when a cold editable shortcut is not granted by the manifest', async () => {
        const denied = catalog();
        denied.commands = denied.commands.map((command) =>
            command.id === 'publisher.fixture.refresh'
                ? { ...command, allowInEditable: false }
                : command,
        );
        mocks.request.mockImplementation((method) =>
            Promise.resolve(method === 'viewContainers.catalog' ? denied : {}),
        );

        await executeEditableViewCatalogShortcut('publisher.fixture.refresh', ['editable']);

        expect(mocks.request).not.toHaveBeenCalledWith(
            'viewContainers.executeCommand',
            expect.anything(),
        );
    });

    it('reports command failures through the shared toast path', async () => {
        mocks.request.mockImplementation((method) =>
            method === 'viewContainers.executeCommand'
                ? Promise.reject(new Error('fixture failed'))
                : Promise.resolve({}),
        );

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
                'session.updateState',
                {
                    sessionId: 'session-1',
                    workbenchProjectId: 'project-1',
                    desiredSecondarySidebarViewContainerId: 'publisher.fixture',
                    paneLayout: {},
                },
            ],
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

    it('reveals a cached container shortcut before an invalidated catalog reload settles', async () => {
        const catalogRequest = Promise.withResolvers<unknown>();
        queryClient.setQueryData(caxriQueryKey('viewContainers.catalog', {}), catalog());
        await queryClient.invalidateQueries({
            queryKey: caxriQueryKey('viewContainers.catalog', {}),
            refetchType: 'none',
        });
        mocks.request.mockImplementation((method) =>
            method === 'viewContainers.catalog' ? catalogRequest.promise : Promise.resolve({}),
        );

        const dispatch = executeViewCatalogShortcut('viewContainers.show.publisher.fixture');
        const selectedImmediately =
            useWorkbenchStore.getState().bootstrap?.sessionStates[0]
                ?.desiredSecondarySidebarViewContainerId;
        catalogRequest.resolve(catalog());
        await dispatch;

        expect(selectedImmediately).toBe('publisher.fixture');
        expect(mocks.request).not.toHaveBeenCalledWith('viewContainers.catalog', {});
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

describe('dispatchExtensionViewAction', () => {
    it('awaits one extension command dispatch for an in-place action', async () => {
        const request = Promise.withResolvers<unknown>();
        mocks.request.mockReturnValueOnce(request.promise);
        const dispatch = dispatchExtensionViewAction(
            'publisher.fixture.refresh',
            'Refresh Fixture',
        );

        expect(mocks.request).toHaveBeenCalledTimes(1);
        expect(mocks.request).toHaveBeenCalledWith('viewContainers.executeCommand', {
            commandId: 'publisher.fixture.refresh',
            arguments: [],
        });
        request.resolve({ executed: true });
        await expect(dispatch).resolves.toBe('executed');
    });
});

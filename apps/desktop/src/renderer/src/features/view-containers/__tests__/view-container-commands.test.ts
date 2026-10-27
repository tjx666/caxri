import type { BootstrapState, ViewCatalogSnapshot } from '@caxri/protocol';
import { createPaneLayout } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn<(method: string, parameters?: unknown) => Promise<unknown>>(() =>
        Promise.resolve({}),
    ),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { caxriQueryKey, queryClient } from '../../../queries/client';
import { useChromeLayoutStore } from '../../../stores/chrome-layout';
import { dismissToast, getToasts } from '../../../stores/toasts';
import { useWorkbenchStore } from '../../../stores/workbench';
import {
    actionFailureMessage,
    didExecuteViewCatalogCommand,
    dispatchExtensionViewAction,
    executeEditableViewCatalogShortcut,
    executeViewCatalogShortcut,
    getCachedViewCatalogCommandAllowedInEditable,
    isCachedViewCatalogCommandAllowedInEditable,
} from '../view-container-commands';

/**
 * The Session `beforeEach` selects, which every extension command carries so Server Core can refuse to start it after a
 * switch.
 */
const selectedSessionContext = {
    kind: 'session',
    sessionId: 'session-1',
    workbenchRootProjectId: 'project-1',
} as const;

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
    dismissToast();
    useWorkbenchStore.setState({
        bootstrap: {
            selectedSessionId: 'session-1',
            sessions: [
                {
                    id: 'session-1',
                    projectId: 'project-1',
                    workbenchRootProjectId: 'project-1',
                },
            ],
            sessionStates: [
                {
                    sessionId: 'session-1',
                    workbenchRootProjectId: 'project-1',
                    desiredSecondarySidebarViewContainerId: 'caxri.files',
                    paneLayout: createPaneLayout(undefined, () => 'pane-1'),
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
                context: selectedSessionContext,
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
            context: selectedSessionContext,
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
            workbenchRootProjectId: 'project-1',
            desiredSecondarySidebarViewContainerId: 'publisher.fixture',
            paneLayout: createPaneLayout(undefined, () => 'pane-1'),
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
            context: selectedSessionContext,
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
            expect(getToasts()).toEqual([
                expect.objectContaining({
                    type: 'error',
                    title: 'Unable to run Refresh Fixture. fixture failed.',
                }),
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
                    workbenchRootProjectId: 'project-1',
                    desiredSecondarySidebarViewContainerId: 'publisher.fixture',
                    paneLayout: createPaneLayout(undefined, () => 'pane-1'),
                },
            ],
            [
                'viewContainers.executeCommand',
                {
                    commandId: 'publisher.fixture.refresh',
                    arguments: ['shortcut'],
                    context: selectedSessionContext,
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
            context: selectedSessionContext,
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

        expect(getToasts()).toEqual([
            expect.objectContaining({
                type: 'error',
                title: 'Unknown command: publisher.fixture.unknown',
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
            context: selectedSessionContext,
        });
        request.resolve({ executed: true });
        await expect(dispatch).resolves.toBe('executed');
    });
});

describe('dispatchExtensionViewAction with action feedback', () => {
    const feedback = {
        success: 'Merged #42',
        failure: "Couldn't merge #42",
        githubUrl: 'https://github.com/acme/widget/pull/42',
    };

    it('confirms success with the declared copy and an Open on GitHub follow-up', async () => {
        mocks.request.mockResolvedValueOnce({ executed: true });
        await expect(
            dispatchExtensionViewAction('publisher.fixture.merge', 'Merge', [], feedback),
        ).resolves.toBe('executed');
        const toast = getToasts().at(-1);
        expect(toast).toMatchObject({ type: 'success', title: 'Merged #42' });
        expect(toast?.action).toBeTruthy();
    });

    it("prefers the command's own message and keeps the Open on GitHub follow-up", async () => {
        mocks.request.mockResolvedValueOnce({ executed: true, message: 'Squash-merged #42' });
        await dispatchExtensionViewAction('publisher.fixture.merge', 'Merge', [], feedback);
        const toast = getToasts().at(-1);
        expect(toast).toMatchObject({ type: 'success', title: 'Squash-merged #42' });
        expect(toast?.action).toBeTruthy();
    });

    it('reports a failure as the declared prefix plus the command reason', async () => {
        mocks.request.mockRejectedValueOnce(
            Object.assign(new Error('Pull request is not mergeable'), { code: 'GIT' }),
        );
        await expect(
            dispatchExtensionViewAction('publisher.fixture.merge', 'Merge', [], feedback),
        ).resolves.toBe('failed');
        expect(getToasts().at(-1)).toMatchObject({
            type: 'error',
            title: "Couldn't merge #42: Pull request is not mergeable.",
        });
    });
});

describe('extension command result messages', () => {
    it('shows a palette command message as a success toast', async () => {
        mocks.request.mockImplementation((method) =>
            Promise.resolve(
                method === 'viewContainers.catalog'
                    ? catalog()
                    : { executed: true, message: 'Merged #42' },
            ),
        );
        await executeViewCatalogShortcut('publisher.fixture.refresh');
        await vi.waitFor(() =>
            expect(getToasts().at(-1)).toMatchObject({ type: 'success', title: 'Merged #42' }),
        );
    });

    it('stays silent for a command that resolves without a message', async () => {
        const before = getToasts().length;
        mocks.request.mockResolvedValueOnce({ executed: true });
        await expect(
            dispatchExtensionViewAction('publisher.fixture.refresh', 'Refresh Fixture'),
        ).resolves.toBe('executed');
        expect(getToasts()).toHaveLength(before);
    });
});

describe('actionFailureMessage', () => {
    it('joins the label and the sanitized reason with a colon', () => {
        expect(
            actionFailureMessage(new Error('GIT: base branch policy'), "Couldn't merge #7"),
        ).toBe("Couldn't merge #7: base branch policy.");
    });
});

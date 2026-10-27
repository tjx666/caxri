import type { CancellationToken, SourceControlProvider } from 'caxri';
import {
    EventEmitter,
    GitPullRequestErrorMessage,
    ProjectStatusSummaryErrorMessage,
    ThemeIcon,
    TreeItem,
    TreeItemCollapsibleState,
} from 'caxri';
import { describe, expect, it } from 'vitest';

import {
    activateExtension,
    cancelTreeRequest,
    configureExtensions,
    extensionApiBinding,
    getTreeChildren,
    notifyActiveContextChanged,
    notifyGitChanged,
    notifyProjectStatusChanged,
} from '../api-factory';
import { isHostOriginatedError } from '../extension-error';
import { currentViewEventContext } from '../view-event-context';
import { executeViewOperation } from '../view-provider-service';
import { installExtensionFixture, registration } from './api-factory.fixture';

installExtensionFixture();

describe('Extension Host API factory', () => {
    it('binds public runtime values into each extension generation', () => {
        configureExtensions([registration()]);

        expect(extensionApiBinding('fixture-token-1').runtime).toMatchObject({
            GitPullRequestErrorMessage,
            ProjectStatusSummaryErrorMessage,
        });
    });

    it('bounds tree RPC values and expires handles with the activation generation', async () => {
        configureExtensions([registration()]);
        extensionApiBinding('fixture-token-1').api.views.registerTreeDataProvider(
            'publisher.fixture.tree',
            {
                getChildren: (element: string | undefined) => (element ? ['child'] : ['root']),
                getTreeItem: (element: string) => {
                    const item = new TreeItem(element, TreeItemCollapsibleState.Collapsed);
                    item.variant = 'header';
                    return item;
                },
            },
        );

        const root = await getTreeChildren({
            extensionId: 'publisher.fixture',
            generation: 1,
            viewId: 'publisher.fixture.tree',
            requestId: 'root-request',
        });
        expect(root.items).toEqual([
            expect.objectContaining({
                accessibilityLabel: 'root',
                collapsibleState: 'collapsed',
                handle: '1:1',
                label: 'root',
                variant: 'header',
            }),
        ]);

        configureExtensions([registration(2)]);
        await expect(
            getTreeChildren({
                extensionId: 'publisher.fixture',
                generation: 1,
                viewId: 'publisher.fixture.tree',
                parentHandle: root.items[0].handle,
                requestId: 'expired-request',
            }),
        ).rejects.toMatchObject({ code: 'GENERATION_EXPIRED' });
    });

    it('uses explicit TreeItem ids as stable view-scoped identity and rejects duplicates', async () => {
        configureExtensions([registration()]);
        let children = [{ label: 'first' }];
        extensionApiBinding('fixture-token-1').api.views.registerTreeDataProvider(
            'publisher.fixture.tree',
            {
                getChildren: () => children,
                getTreeItem: (element: { label: string }) => {
                    const item = new TreeItem(element.label);
                    item.id = 'stable-item';
                    item.trailingIcon = new ThemeIcon('circle-arrow-up');
                    return item;
                },
            },
        );

        const first = await getTreeChildren({
            extensionId: 'publisher.fixture',
            generation: 1,
            viewId: 'publisher.fixture.tree',
            requestId: 'stable-first',
        });
        children = [{ label: 'replacement' }];
        expect(first.items[0].trailingIcon).toEqual({ kind: 'theme', id: 'circle-arrow-up' });
        const replacement = await getTreeChildren({
            extensionId: 'publisher.fixture',
            generation: 1,
            viewId: 'publisher.fixture.tree',
            requestId: 'stable-replacement',
        });
        expect(replacement.items[0]).toMatchObject({
            handle: first.items[0].handle,
            id: 'stable-item',
            label: 'replacement',
        });

        children = [{ label: 'duplicate-a' }, { label: 'duplicate-b' }];
        await expect(
            getTreeChildren({
                extensionId: 'publisher.fixture',
                generation: 1,
                viewId: 'publisher.fixture.tree',
                requestId: 'stable-duplicate',
            }),
        ).rejects.toMatchObject({ code: 'DUPLICATE_ID' });
    });

    it('retires removed child handles when a parent branch is replaced', async () => {
        configureExtensions([registration()]);
        let childLabel = 'old-child';
        extensionApiBinding('fixture-token-1').api.views.registerTreeDataProvider(
            'publisher.fixture.tree',
            {
                getChildren: (element: { label: string } | undefined) =>
                    element ? [{ label: childLabel }] : [{ label: 'parent' }],
                getTreeItem: (element: { label: string }) => {
                    const item = new TreeItem(element.label, TreeItemCollapsibleState.Collapsed);
                    item.id = element.label;
                    return item;
                },
            },
        );
        const root = await getTreeChildren({
            extensionId: 'publisher.fixture',
            generation: 1,
            viewId: 'publisher.fixture.tree',
            requestId: 'retire-root',
        });
        const firstChildren = await getTreeChildren({
            extensionId: 'publisher.fixture',
            generation: 1,
            viewId: 'publisher.fixture.tree',
            parentHandle: root.items[0].handle,
            requestId: 'retire-old-child',
        });
        childLabel = 'new-child';
        await getTreeChildren({
            extensionId: 'publisher.fixture',
            generation: 1,
            viewId: 'publisher.fixture.tree',
            parentHandle: root.items[0].handle,
            requestId: 'retire-new-child',
        });

        await expect(
            getTreeChildren({
                extensionId: 'publisher.fixture',
                generation: 1,
                viewId: 'publisher.fixture.tree',
                parentHandle: firstChildren.items[0].handle,
                requestId: 'retire-expired-child',
            }),
        ).rejects.toMatchObject({ code: 'GENERATION_EXPIRED' });
    });

    it('propagates cancellation and workspace changes only to the current runtime', async () => {
        configureExtensions([registration()]);
        const binding = extensionApiBinding('fixture-token-1');
        let contextChanges = 0;
        let gitChanges = 0;
        let projectStatusChanges = 0;
        binding.api.workspace.onDidChangeActiveContext(() => contextChanges++);
        binding.api.workspace.onDidChangeGit(() => gitChanges++);
        binding.api.workspace.onDidChangeProjectStatus(() => projectStatusChanges++);
        let isCancellationObserved = false;
        binding.api.views.registerTreeDataProvider('publisher.fixture.tree', {
            getChildren: (_element: string | undefined, token) =>
                new Promise<readonly string[]>((resolve) => {
                    token.onCancellationRequested(() => {
                        isCancellationObserved = true;
                        resolve([]);
                    });
                }),
            getTreeItem: (element: string) => new TreeItem(element),
        });
        await activateExtension('publisher.fixture', 1);

        const pending = getTreeChildren({
            extensionId: 'publisher.fixture',
            generation: 1,
            viewId: 'publisher.fixture.tree',
            requestId: 'cancel-request',
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(cancelTreeRequest('cancel-request')).toEqual({ cancelled: true });
        await expect(pending).resolves.toEqual({ items: [] });
        expect(isCancellationObserved).toBe(true);

        expect(notifyActiveContextChanged({ kind: 'no-session' })).toEqual({ notified: 1 });
        expect(contextChanges).toBe(1);
        expect(projectStatusChanges).toBe(0);

        expect(
            notifyProjectStatusChanged({
                kind: 'session',
                sessionId: 'session-1',
                workbenchRootProjectId: 'project-1',
            }),
        ).toEqual({ notified: 1 });
        expect(contextChanges).toBe(1);
        expect(projectStatusChanges).toBe(1);
        expect(
            notifyGitChanged({
                kind: 'session',
                sessionId: 'session-1',
                workbenchRootProjectId: 'project-1',
            }),
        ).toEqual({ notified: 1 });
        expect(gitChanges).toBe(1);
    });

    it('requires the manifest view kind and propagates cancellation to controlled providers', async () => {
        configureExtensions([registration(1, 'source-control')]);
        const binding = extensionApiBinding('fixture-token-1');
        expect(() =>
            binding.api.views.registerTreeDataProvider('publisher.fixture.tree', {
                getChildren: () => [],
                getTreeItem: (element: string) => new TreeItem(element),
            }),
        ).toThrow('View is not declared');

        let isCancellationObserved = false;
        const provider = {
            provideView: (_request: unknown, token: CancellationToken) =>
                new Promise<Record<string, never>>((resolve) => {
                    token.onCancellationRequested(() => {
                        isCancellationObserved = true;
                        resolve({});
                    });
                }),
        } as unknown as SourceControlProvider;
        binding.api.views.registerSourceControlProvider('publisher.fixture.tree', provider);
        await activateExtension('publisher.fixture', 1);
        const pending = executeViewOperation({
            extensionId: 'publisher.fixture',
            generation: 1,
            viewId: 'publisher.fixture.tree',
            operation: 'source.snapshot',
            arguments: { refresh: 0 },
            requestId: 'view-cancel-request',
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(cancelTreeRequest('view-cancel-request')).toEqual({ cancelled: true });
        let cancellation: unknown;
        try {
            await pending;
        } catch (error) {
            cancellation = error;
        }
        expect(cancellation).toMatchObject({ code: 'CANCELLED' });
        // A real cancellation is minted through `hostError`, unlike a code an extension could forge itself.
        expect(isHostOriginatedError(cancellation)).toBe(true);
        expect(isCancellationObserved).toBe(true);

        configureExtensions([registration(2, 'source-control')]);
        await expect(
            executeViewOperation({
                extensionId: 'publisher.fixture',
                generation: 1,
                viewId: 'publisher.fixture.tree',
                operation: 'source.snapshot',
                arguments: { refresh: 0 },
                requestId: 'expired-view-request',
            }),
        ).rejects.toMatchObject({ code: 'PROVIDER_MISSING' });
    });

    it('retains a bounded cancel tombstone when cancellation wins before provider registration', async () => {
        configureExtensions([registration(1, 'source-control')]);

        expect(cancelTreeRequest('cancel-before-registration')).toEqual({ cancelled: true });
        let tombstoneRejection: unknown;
        try {
            await executeViewOperation({
                extensionId: 'publisher.fixture',
                generation: 1,
                viewId: 'publisher.fixture.tree',
                operation: 'source.snapshot',
                arguments: { refresh: 0 },
                requestId: 'cancel-before-registration',
            });
        } catch (error) {
            tombstoneRejection = error;
        }
        expect(tombstoneRejection).toMatchObject({ code: 'CANCELLED' });
        expect(isHostOriginatedError(tombstoneRejection)).toBe(true);
    });

    it('rejects providers that exceed the item limit', async () => {
        configureExtensions([registration()]);
        extensionApiBinding('fixture-token-1').api.views.registerTreeDataProvider(
            'publisher.fixture.tree',
            {
                getChildren: () => Array.from({ length: 1_001 }, (_, index) => index),
                getTreeItem: (element: number) => new TreeItem(String(element)),
            },
        );

        await expect(
            getTreeChildren({
                extensionId: 'publisher.fixture',
                generation: 1,
                viewId: 'publisher.fixture.tree',
                requestId: 'overflow-request',
            }),
        ).rejects.toMatchObject({ code: 'PROVIDER_CAPACITY' });
    });

    it('normalizes provider failures and discards late results after cancellation', async () => {
        configureExtensions([registration()]);
        const binding = extensionApiBinding('fixture-token-1');
        binding.api.views.registerTreeDataProvider('publisher.fixture.tree', {
            getChildren: () => {
                throw new Error('provider exploded');
            },
            getTreeItem: (element: string) => new TreeItem(element),
        });
        await expect(
            getTreeChildren({
                extensionId: 'publisher.fixture',
                generation: 1,
                viewId: 'publisher.fixture.tree',
                requestId: 'provider-error-request',
            }),
        ).rejects.toMatchObject({ code: 'PROVIDER_FAILED', message: 'provider exploded' });

        configureExtensions([registration(2)]);
        let resolveLate!: (children: readonly string[]) => void;
        const started = Promise.withResolvers<void>();
        let calls = 0;
        extensionApiBinding('fixture-token-2').api.views.registerTreeDataProvider(
            'publisher.fixture.tree',
            {
                getChildren: () => {
                    calls += 1;
                    if (calls === 1)
                        return new Promise<readonly string[]>((resolve) => {
                            resolveLate = resolve;
                            started.resolve();
                        });
                    return ['fresh'];
                },
                getTreeItem: (element: string) => new TreeItem(element),
            },
        );
        const late = getTreeChildren({
            extensionId: 'publisher.fixture',
            generation: 2,
            viewId: 'publisher.fixture.tree',
            requestId: 'late-request',
        });
        await started.promise;
        expect(cancelTreeRequest('late-request')).toEqual({ cancelled: true });
        resolveLate(['stale']);
        await expect(late).resolves.toEqual({ items: [] });

        await expect(
            getTreeChildren({
                extensionId: 'publisher.fixture',
                generation: 2,
                viewId: 'publisher.fixture.tree',
                requestId: 'fresh-request',
            }),
        ).resolves.toEqual({
            items: [expect.objectContaining({ handle: '2:1', label: 'fresh' })],
        });
    });

    it('discards a request that started before a provider root refresh', async () => {
        configureExtensions([registration()]);
        // eslint-disable-next-line unicorn/prefer-event-target -- Verify the public VS Code-compatible provider event.
        const changes = new EventEmitter<undefined>();
        const staleStarted = Promise.withResolvers<void>();
        let resolveStale!: (children: ReadonlyArray<{ label: string }>) => void;
        let rootCalls = 0;
        extensionApiBinding('fixture-token-1').api.views.registerTreeDataProvider(
            'publisher.fixture.tree',
            {
                onDidChangeTreeData: changes.event,
                getChildren: (element: { label: string } | undefined) => {
                    if (element) return [{ label: `child-of-${element.label}` }];
                    rootCalls += 1;
                    if (rootCalls === 1)
                        return new Promise<ReadonlyArray<{ label: string }>>((resolve) => {
                            resolveStale = resolve;
                            staleStarted.resolve();
                        });
                    return [{ label: 'fresh' }];
                },
                getTreeItem: (element: { label: string }) => {
                    const item = new TreeItem(element.label, TreeItemCollapsibleState.Collapsed);
                    item.id =
                        element.label === 'stale' || element.label === 'fresh'
                            ? 'root'
                            : element.label;
                    return item;
                },
            },
        );

        const stale = getTreeChildren({
            extensionId: 'publisher.fixture',
            generation: 1,
            viewId: 'publisher.fixture.tree',
            requestId: 'stale-before-root-refresh',
        });
        await staleStarted.promise;
        changes.fire(undefined);
        const fresh = await getTreeChildren({
            extensionId: 'publisher.fixture',
            generation: 1,
            viewId: 'publisher.fixture.tree',
            requestId: 'fresh-after-root-refresh',
        });
        resolveStale([{ label: 'stale' }]);

        await expect(stale).rejects.toMatchObject({ code: 'GENERATION_EXPIRED' });
        await expect(
            getTreeChildren({
                extensionId: 'publisher.fixture',
                generation: 1,
                viewId: 'publisher.fixture.tree',
                parentHandle: fresh.items[0].handle,
                requestId: 'fresh-child-after-root-refresh',
            }),
        ).resolves.toEqual({
            items: [expect.objectContaining({ label: 'child-of-fresh' })],
        });
    });

    it('keeps delayed provider refreshes in the active no-session scope', async () => {
        configureExtensions([registration()]);
        // eslint-disable-next-line unicorn/prefer-event-target -- Verify the public VS Code-compatible provider event.
        const changes = new EventEmitter<undefined>();
        let observedContext: ReturnType<typeof currentViewEventContext>;
        let observedPublicContext: { scopeId: string } | undefined;
        const binding = extensionApiBinding('fixture-token-1');
        binding.api.workspace.onDidChangeActiveContext(() => changes.fire(undefined));
        binding.api.views.registerTreeDataProvider('publisher.fixture.tree', {
            onDidChangeTreeData: (listener) =>
                changes.event((element) => {
                    observedContext = currentViewEventContext();
                    observedPublicContext = binding.api.workspace.getCurrentContext();
                    listener(element);
                }),
            getChildren: () => [],
            getTreeItem: (element: string) => new TreeItem(element),
        });
        await activateExtension('publisher.fixture', 1);

        notifyActiveContextChanged({ kind: 'no-session' });
        await new Promise((resolve) => setTimeout(resolve, 40));

        expect(observedContext).toEqual({ kind: 'no-session' });
        expect(observedPublicContext).toEqual({ scopeId: 'no-session' });
    });

    it('bounds serialized payloads and generation-scoped tree depth', async () => {
        configureExtensions([registration()]);
        const binding = extensionApiBinding('fixture-token-1');
        binding.api.views.registerTreeDataProvider('publisher.fixture.tree', {
            getChildren: () => Array.from({ length: 300 }, (_, index) => index),
            getTreeItem: () => new TreeItem('x'.repeat(1_000)),
        });
        await expect(
            getTreeChildren({
                extensionId: 'publisher.fixture',
                generation: 1,
                viewId: 'publisher.fixture.tree',
                requestId: 'payload-request',
            }),
        ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });

        configureExtensions([registration(2)]);
        extensionApiBinding('fixture-token-2').api.views.registerTreeDataProvider(
            'publisher.fixture.tree',
            {
                getChildren: (element: number | undefined) => [
                    element === undefined ? 0 : element + 1,
                ],
                getTreeItem: (element: number) =>
                    new TreeItem(String(element), TreeItemCollapsibleState.Collapsed),
            },
        );
        let parentHandle: string | undefined;
        for (let depth = 0; depth <= 64; depth++) {
            // eslint-disable-next-line no-await-in-loop -- Each request depends on the handle returned by the preceding depth.
            const result = await getTreeChildren({
                extensionId: 'publisher.fixture',
                generation: 2,
                viewId: 'publisher.fixture.tree',
                ...(parentHandle && { parentHandle }),
                requestId: `depth-${depth}`,
            });
            parentHandle = result.items[0].handle;
        }
        await expect(
            getTreeChildren({
                extensionId: 'publisher.fixture',
                generation: 2,
                viewId: 'publisher.fixture.tree',
                parentHandle,
                requestId: 'depth-overflow',
            }),
        ).rejects.toMatchObject({ code: 'PROVIDER_CAPACITY' });
    });

    it('retires old API bindings, pending calls, tree results, and refresh events on reload', async () => {
        configureExtensions([registration()]);
        const oldBinding = extensionApiBinding('fixture-token-1');
        // eslint-disable-next-line unicorn/prefer-event-target -- Verify the VS Code-compatible EventEmitter behavior exposed by the public API.
        const oldChanges = new EventEmitter<string | readonly string[] | undefined>();
        let resolveOldChildren!: (children: readonly string[]) => void;
        const oldStarted = Promise.withResolvers<void>();
        oldBinding.api.views.registerTreeDataProvider('publisher.fixture.tree', {
            onDidChangeTreeData: oldChanges.event,
            getChildren: () =>
                new Promise<readonly string[]>((resolve) => {
                    resolveOldChildren = resolve;
                    oldStarted.resolve();
                }),
            getTreeItem: (element: string) =>
                new TreeItem(element, TreeItemCollapsibleState.Collapsed),
        });
        const oldTree = getTreeChildren({
            extensionId: 'publisher.fixture',
            generation: 1,
            viewId: 'publisher.fixture.tree',
            requestId: 'old-tree',
        });
        await oldStarted.promise;
        const oldApiCall = oldBinding.api.workspace.getProjectStatus();

        configureExtensions([registration(2)]);
        expect(() =>
            oldBinding.api.commands.registerCommand('publisher.fixture.command', () => {}),
        ).toThrow(expect.objectContaining({ code: 'GENERATION_EXPIRED' }));
        await expect(oldApiCall).rejects.toMatchObject({ code: 'GENERATION_EXPIRED' });
        resolveOldChildren(['stale']);
        await expect(oldTree).rejects.toMatchObject({ code: 'GENERATION_EXPIRED' });

        extensionApiBinding('fixture-token-2').api.views.registerTreeDataProvider(
            'publisher.fixture.tree',
            {
                getChildren: (element: string | undefined) => (element ? ['child'] : ['current']),
                getTreeItem: (element: string) =>
                    new TreeItem(element, TreeItemCollapsibleState.Collapsed),
            },
        );
        const current = await getTreeChildren({
            extensionId: 'publisher.fixture',
            generation: 2,
            viewId: 'publisher.fixture.tree',
            requestId: 'current-root',
        });
        oldChanges.fire(undefined);
        await new Promise((resolve) => setTimeout(resolve, 40));
        await expect(
            getTreeChildren({
                extensionId: 'publisher.fixture',
                generation: 2,
                viewId: 'publisher.fixture.tree',
                parentHandle: current.items[0].handle,
                requestId: 'current-child',
            }),
        ).resolves.toEqual({
            items: [expect.objectContaining({ label: 'child' })],
        });
    });
});

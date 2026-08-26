import { StructuredLogger } from '@caxri/system';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const supervisorHarness = vi.hoisted(() => ({
    activation: Promise.withResolvers<void>(),
    exitListeners: [] as Array<(code: number) => void>,
    requests: [] as Array<{ method: string; parameters?: Record<string, unknown> }>,
    startListeners: [] as Array<() => void>,
    treeChildrenFailure: undefined as Error | undefined,
    viewOperationResult: undefined as unknown,
}));

vi.mock('../catalog', () => ({
    buildViewCatalog: ({
        revision,
        states,
    }: {
        revision: number;
        states: Map<
            string,
            {
                generation: number;
                lifecycle: 'active' | 'activating' | 'crashed' | 'discovered' | 'error';
                error?: { code: string; message: string };
            }
        >;
    }) => {
        const state = states.get('publisher.fixture')!;
        return Promise.resolve({
            revision,
            containers: [],
            views: [
                {
                    id: 'publisher.fixture.tree',
                    containerId: 'publisher.fixture',
                    source: { kind: 'extension', extensionId: 'publisher.fixture' },
                    extensionId: 'publisher.fixture',
                    viewKind: 'tree',
                    title: 'Fixture',
                    lifecycle: state.lifecycle,
                },
                {
                    id: 'publisher.fixture.sourceControl',
                    containerId: 'publisher.fixture',
                    source: { kind: 'extension', extensionId: 'publisher.fixture' },
                    extensionId: 'publisher.fixture',
                    viewKind: { kind: 'source-control' },
                    title: 'Source Control',
                    lifecycle: state.lifecycle,
                },
            ],
            commands: [],
            extensions: [
                {
                    id: 'publisher.fixture',
                    version: '1.0.0',
                    generation: state.generation,
                    lifecycle: state.lifecycle,
                    ...(state.error && { error: state.error }),
                },
            ],
        });
    },
}));

vi.mock('../discovery', () => ({
    discoverExtensions: () =>
        Promise.resolve({
            extensions: [
                {
                    extensionId: 'publisher.fixture',
                    source: 'bundled',
                    rootPath: '/extensions/fixture',
                    entryPath: '/extensions/fixture/dist/extension.js',
                    manifest: {
                        name: 'publisher.fixture',
                        version: '1.0.0',
                        type: 'module',
                        main: './dist/extension.js',
                        engines: { caxri: '^0.0.17' },
                        caxri: { capabilities: [] },
                        contributes: {
                            viewsContainers: {
                                secondarySidebar: [
                                    {
                                        id: 'publisher.fixture',
                                        title: 'Fixture',
                                        icon: {
                                            kind: 'resource',
                                            path: 'media/fixture.svg',
                                        },
                                    },
                                ],
                                panel: [],
                            },
                            views: {
                                'publisher.fixture': [
                                    {
                                        id: 'publisher.fixture.tree',
                                        name: 'Fixture',
                                        type: 'tree',
                                    },
                                ],
                            },
                            commands: [],
                        },
                    },
                },
            ],
            rejected: [],
        }),
}));

vi.mock('../supervisor', () => ({
    ExtensionHostSupervisor: class {
        onEvent() {
            return () => {};
        }

        onExit(listener: (code: number) => void) {
            supervisorHarness.exitListeners.push(listener);
            return () => {};
        }

        onStart(listener: () => void) {
            supervisorHarness.startListeners.push(listener);
            return () => {};
        }

        start() {
            for (const listener of supervisorHarness.startListeners) listener();
            return Promise.resolve();
        }

        request(method: string, parameters?: Record<string, unknown>): Promise<unknown> {
            supervisorHarness.requests.push({ method, parameters });
            if (method === 'activate') return supervisorHarness.activation.promise;
            if (method === 'treeChildren') {
                const failure = supervisorHarness.treeChildrenFailure;
                supervisorHarness.treeChildrenFailure = undefined;
                if (failure) return Promise.reject(failure);
            } else if (method === 'viewOperation')
                return Promise.resolve(supervisorHarness.viewOperationResult);
            return Promise.resolve({ items: [] });
        }

        restart() {
            return Promise.resolve();
        }

        shutdown() {
            return Promise.resolve();
        }

        processId() {
            return 1;
        }
    },
}));

import { ExtensionService } from '../service';

describe('ExtensionService generation lifecycle', () => {
    beforeEach(() => {
        supervisorHarness.activation = Promise.withResolvers<void>();
        supervisorHarness.exitListeners.length = 0;
        supervisorHarness.requests.length = 0;
        supervisorHarness.startListeners.length = 0;
        supervisorHarness.treeChildrenFailure = undefined;
        supervisorHarness.viewOperationResult = undefined;
    });

    it('cancels a controlled operation before activation when its Renderer scope is stale', async () => {
        const service = new ExtensionService({
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            extensionRoots: ['/extensions'],
            includeTestOnly: true,
            logger: new StructuredLogger('/tmp/caxri-extension-service-test', 'host', 'error'),
            activeContext: () =>
                Promise.resolve({
                    ownerProjectId: 'project-2',
                    sessionId: 'session-2',
                    workbenchProjectId: 'project-2',
                }),
            projectIds: () => Promise.resolve(['project-2']),
            projectStatus: () => Promise.resolve({ repositories: [], refreshedAt: 1 }),
            workspaceRequest: () => Promise.resolve(null),
        });
        await service.start();

        await expect(
            service.viewOperation({
                viewId: 'publisher.fixture.sourceControl',
                operation: 'source.snapshot',
                arguments: { refresh: 0 },
                requestId: 'stale-scope',
                context: {
                    kind: 'session',
                    sessionId: 'session-1',
                    workbenchProjectId: 'project-1',
                },
            }),
        ).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(supervisorHarness.requests).not.toContainEqual(
            expect.objectContaining({ method: 'activate' }),
        );
    });

    it.each(['CONFLICT', 'GENERATION_EXPIRED'] as const)(
        'classifies an in-flight controlled read scope change as cancellation after %s',
        async (nestedCode) => {
            let active = {
                ownerProjectId: 'project-1',
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
            };
            const service = new ExtensionService({
                appVersion: '0.0.17',
                commit: 'test',
                extensionHostPath: '/out/main/extension-host.js',
                extensionRoots: ['/extensions'],
                includeTestOnly: true,
                logger: new StructuredLogger('/tmp/caxri-extension-service-test', 'host', 'error'),
                activeContext: () => Promise.resolve(active),
                projectIds: () => Promise.resolve(['project-1', 'project-2']),
                projectStatus: () => Promise.resolve({ repositories: [], refreshedAt: 1 }),
                workspaceRequest: () => Promise.resolve(null),
            });
            await service.start();
            supervisorHarness.activation.resolve();
            const pending = Promise.withResolvers<unknown>();
            supervisorHarness.viewOperationResult = pending.promise;

            const request = service.viewOperation({
                viewId: 'publisher.fixture.sourceControl',
                operation: 'source.snapshot',
                arguments: { refresh: 0 },
                requestId: 'in-flight-stale-scope',
                context: {
                    kind: 'session',
                    sessionId: 'session-1',
                    workbenchProjectId: 'project-1',
                },
            });
            await vi.waitFor(() =>
                expect(supervisorHarness.requests).toContainEqual(
                    expect.objectContaining({ method: 'viewOperation' }),
                ),
            );
            active = {
                ownerProjectId: 'project-2',
                sessionId: 'session-2',
                workbenchProjectId: 'project-2',
            };
            pending.reject(
                Object.assign(new Error('Active Project changed while the request was running'), {
                    code: nestedCode,
                }),
            );

            await expect(request).rejects.toMatchObject({ code: 'CANCELLED' });
        },
    );

    it('does not let a rejected retired activation overwrite the crash generation', async () => {
        const service = new ExtensionService({
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            extensionRoots: ['/extensions'],
            includeTestOnly: true,
            logger: new StructuredLogger('/tmp/caxri-extension-service-test', 'host', 'error'),
            activeContext: () => Promise.resolve({}),
            projectIds: () => Promise.resolve([]),
            projectStatus: () => Promise.resolve({ repositories: [], refreshedAt: 1 }),
            workspaceRequest: () => Promise.resolve(null),
        });
        await service.start();

        const pending = service.treeChildren({
            viewId: 'publisher.fixture.tree',
            requestId: 'request-1',
        });
        const failure = Object.assign(new Error('Extension Host crashed'), {
            code: 'EXTENSION_HOST_UNAVAILABLE',
        });
        supervisorHarness.activation.reject(failure);
        for (const listener of supervisorHarness.exitListeners) listener(1);

        await expect(pending).rejects.toBe(failure);
        expect(service.catalog().extensions).toContainEqual(
            expect.objectContaining({
                id: 'publisher.fixture',
                generation: 2,
                lifecycle: 'crashed',
            }),
        );
    });

    it('clears the crash error when recovery activation started before the child became ready', async () => {
        const service = new ExtensionService({
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            extensionRoots: ['/extensions'],
            includeTestOnly: true,
            logger: new StructuredLogger('/tmp/caxri-extension-service-test', 'host', 'error'),
            activeContext: () => Promise.resolve({}),
            projectIds: () => Promise.resolve([]),
            projectStatus: () => Promise.resolve({ repositories: [], refreshedAt: 1 }),
            workspaceRequest: () => Promise.resolve(null),
        });
        await service.start();
        for (const listener of supervisorHarness.exitListeners) listener(86);
        const viewModel = {
            revision: '1',
            title: 'Source Control',
            accessibilityLabel: 'Repositories',
            modeAccessibilityLabel: 'Source control mode',
            modes: [],
            selectedModeId: 'default',
            refreshAction: {
                id: 'action-1',
                label: 'Refresh',
                icon: { kind: 'theme', id: 'refresh' },
                command: { id: 'publisher.fixture.refresh' },
            },
            providers: [],
            emptyMessage: 'No repositories.',
        };
        supervisorHarness.viewOperationResult = viewModel;

        const recovery = service.viewOperation({
            viewId: 'publisher.fixture.sourceControl',
            operation: 'source.snapshot',
            arguments: { refresh: 0 },
            requestId: 'recovery-git-summary',
            context: { kind: 'no-session' },
        });
        await vi.waitFor(() =>
            expect(supervisorHarness.requests).toContainEqual(
                expect.objectContaining({ method: 'activate' }),
            ),
        );
        for (const listener of supervisorHarness.startListeners) listener();
        supervisorHarness.activation.resolve();

        await expect(recovery).resolves.toEqual(viewModel);
        expect(service.catalog().extensions).toContainEqual({
            id: 'publisher.fixture',
            version: '1.0.0',
            generation: 2,
            lifecycle: 'active',
        });
    });

    it('recovers an expired branch handle with a current root snapshot', async () => {
        const service = new ExtensionService({
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            extensionRoots: ['/extensions'],
            includeTestOnly: true,
            logger: new StructuredLogger('/tmp/caxri-extension-service-test', 'host', 'error'),
            activeContext: () => Promise.resolve({}),
            projectIds: () => Promise.resolve([]),
            projectStatus: () => Promise.resolve({ repositories: [], refreshedAt: 1 }),
            workspaceRequest: () => Promise.resolve(null),
        });
        await service.start();
        supervisorHarness.activation.resolve();
        supervisorHarness.treeChildrenFailure = Object.assign(new Error('Tree handle expired'), {
            code: 'GENERATION_EXPIRED',
        });

        await expect(
            service.treeChildren({
                viewId: 'publisher.fixture.tree',
                parentHandle: 'stale-handle',
                requestId: 'request-1',
            }),
        ).resolves.toEqual({ items: [], reset: true });
        const treeRequests = supervisorHarness.requests.filter(
            ({ method }) => method === 'treeChildren',
        );
        expect(treeRequests).toHaveLength(2);
        expect(treeRequests[0]?.parameters?.parentHandle).toBe('stale-handle');
        expect(treeRequests[1]?.parameters).not.toHaveProperty('parentHandle');
    });

    it('recovers a root request invalidated by a concurrent provider refresh', async () => {
        const service = new ExtensionService({
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            extensionRoots: ['/extensions'],
            includeTestOnly: true,
            logger: new StructuredLogger('/tmp/caxri-extension-service-test', 'host', 'error'),
            activeContext: () => Promise.resolve({}),
            projectIds: () => Promise.resolve([]),
            projectStatus: () => Promise.resolve({ repositories: [], refreshedAt: 1 }),
            workspaceRequest: () => Promise.resolve(null),
        });
        await service.start();
        supervisorHarness.activation.resolve();
        supervisorHarness.treeChildrenFailure = Object.assign(
            new Error('Tree provider refreshed while the request was running'),
            { code: 'GENERATION_EXPIRED' },
        );

        await expect(
            service.treeChildren({
                viewId: 'publisher.fixture.tree',
                requestId: 'request-1',
            }),
        ).resolves.toEqual({ items: [] });
        const treeRequests = supervisorHarness.requests.filter(
            ({ method }) => method === 'treeChildren',
        );
        expect(treeRequests).toHaveLength(2);
        expect(treeRequests.every(({ parameters }) => !parameters?.parentHandle)).toBe(true);
    });

    it('validates a controlled view result against its exact operation schema', async () => {
        const service = new ExtensionService({
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            extensionRoots: ['/extensions'],
            includeTestOnly: true,
            logger: new StructuredLogger('/tmp/caxri-extension-service-test', 'host', 'error'),
            activeContext: () => Promise.resolve({}),
            projectIds: () => Promise.resolve([]),
            projectStatus: () => Promise.resolve({ repositories: [], refreshedAt: 1 }),
            workspaceRequest: () => Promise.resolve(null),
        });
        await service.start();
        supervisorHarness.activation.resolve();
        supervisorHarness.viewOperationResult = [];

        await expect(
            service.viewOperation({
                viewId: 'publisher.fixture.sourceControl',
                operation: 'source.snapshot',
                arguments: { refresh: 0 },
                requestId: 'request-git-summary',
                context: { kind: 'no-session' },
            }),
        ).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    });
});

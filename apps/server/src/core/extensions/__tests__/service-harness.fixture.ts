/**
 * Shared doubles for `ExtensionService` tests that drive one discovered fixture extension through a scripted Extension
 * Host supervisor. Test files install them with `vi.mock(..., async () => (await import(...)).xModule)` and must call
 * `resetSupervisorHarness` in `beforeEach`, because the harness is module state shared by every test in the file. This
 * module never imports `../service` itself: the mocked modules load while `../service` is being imported.
 */

export const supervisorHarness = {
    activation: Promise.withResolvers<void>(),
    exitListeners: [] as Array<(code: number) => void>,
    requests: [] as Array<{ method: string; parameters?: Record<string, unknown> }>,
    startListeners: [] as Array<() => void>,
    treeChildrenFailure: undefined as Error | undefined,
    viewOperationResult: undefined as unknown,
};

export function resetSupervisorHarness(): void {
    supervisorHarness.activation = Promise.withResolvers<void>();
    supervisorHarness.exitListeners.length = 0;
    supervisorHarness.requests.length = 0;
    supervisorHarness.startListeners.length = 0;
    supervisorHarness.treeChildrenFailure = undefined;
    supervisorHarness.viewOperationResult = undefined;
}

export const catalogModule = {
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
                    viewKind: { kind: 'tree' },
                    badge: true,
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
};

export const discoveryModule = {
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
};

export const supervisorModule = {
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
};

export const observationIdentity = {
    bootId: 'b'.repeat(32),
    buildId: 'build-1',
    serverId: 'c'.repeat(32),
    userDataPath: '/tmp/caxri-extension-service-test',
};

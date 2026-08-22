import { describe, expect, it, vi } from 'vitest';

import { StructuredLogger } from '../../../shared/node/logger';

const supervisorHarness = vi.hoisted(() => ({
    activation: Promise.withResolvers<void>(),
    exitListeners: [] as Array<(code: number) => void>,
    startListeners: [] as Array<() => void>,
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

        request(method: string): Promise<unknown> {
            if (method === 'activate') return supervisorHarness.activation.promise;
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
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StructuredLogger } from '../../../shared/node/logger';

const harness = vi.hoisted(() => ({
    isManifestValid: false,
    registrations: undefined as undefined | (() => unknown[]),
    restart: vi.fn(() => Promise.resolve()),
}));

const rejectedExtensionId = 'invalid.broken-123456789abc';

vi.mock('../discovery', () => ({
    discoverExtensions: () =>
        Promise.resolve(
            harness.isManifestValid
                ? {
                      extensions: [
                          {
                              extensionId: 'publisher.fixed',
                              source: 'installed',
                              rootPath: '/extensions/broken',
                              entryPath: '/extensions/broken/dist/extension.js',
                              manifest: {
                                  name: 'publisher.fixed',
                                  version: '1.0.0',
                                  type: 'module',
                                  main: './dist/extension.js',
                                  engines: { caxri: '^0.0.17' },
                                  caxri: { capabilities: [] },
                                  contributes: {
                                      viewsContainers: {
                                          secondarySidebar: [
                                              {
                                                  id: 'publisher.fixed',
                                                  title: 'Fixed extension',
                                                  icon: { kind: 'builtin', id: 'status' },
                                              },
                                          ],
                                          panel: [],
                                      },
                                      views: {},
                                      commands: [],
                                  },
                              },
                          },
                      ],
                      rejected: [],
                  }
                : {
                      extensions: [],
                      rejected: [
                          {
                              extensionId: rejectedExtensionId,
                              version: 'unknown',
                              error: {
                                  code: 'MANIFEST_INVALID',
                                  message: 'Extension package.json is invalid JSON',
                              },
                          },
                      ],
                  },
        ),
}));

vi.mock('../supervisor', () => ({
    ExtensionHostSupervisor: class {
        constructor(options: { registrations: () => unknown[] }) {
            harness.registrations = options.registrations;
        }

        onEvent() {
            return () => {};
        }

        onExit() {
            return () => {};
        }

        onStart() {
            return () => {};
        }

        start() {
            return Promise.resolve();
        }

        restart() {
            harness.registrations?.();
            return harness.restart();
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

function service(): ExtensionService {
    return new ExtensionService({
        appVersion: '0.0.17',
        commit: 'test',
        extensionHostPath: '/out/main/extension-host.js',
        extensionRoots: ['/extensions'],
        includeTestOnly: true,
        logger: new StructuredLogger('/tmp/caxri-extension-retry-test', 'host', 'error'),
        activeContext: () => Promise.resolve({}),
        projectIds: () => Promise.resolve([]),
        projectStatus: () => Promise.resolve({ repositories: [], refreshedAt: 1 }),
    });
}

beforeEach(() => {
    harness.isManifestValid = false;
    harness.registrations = undefined;
    harness.restart.mockClear();
});

describe('ExtensionService rejected extension retry', () => {
    it('keeps a malformed extension visible when rediscovery still rejects it', async () => {
        const extensionService = service();
        await extensionService.start();

        const result = await extensionService.retry(rejectedExtensionId);

        expect(result).toEqual({
            accepted: false,
            error: {
                code: 'MANIFEST_INVALID',
                message: 'Extension package.json is invalid JSON',
            },
        });
        expect(
            extensionService.catalog().containers.find(({ id }) => id === rejectedExtensionId),
        ).toMatchObject({ lifecycle: 'error' });
        expect(harness.restart).not.toHaveBeenCalled();
    });

    it('rediscovers a repaired manifest and restarts with its healthy identity', async () => {
        const extensionService = service();
        await extensionService.start();
        harness.isManifestValid = true;

        await expect(extensionService.retry(rejectedExtensionId)).resolves.toEqual({
            accepted: true,
        });

        expect(harness.restart).toHaveBeenCalledTimes(1);
        expect(extensionService.catalog().containers.map(({ id }) => id)).toContain(
            'publisher.fixed',
        );
        expect(extensionService.catalog().containers.map(({ id }) => id)).not.toContain(
            rejectedExtensionId,
        );
    });
});

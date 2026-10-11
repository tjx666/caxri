import { StructuredLogger } from '@caxri/system';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    observationIdentity,
    resetSupervisorHarness,
    supervisorHarness,
} from './service-harness.fixture';

vi.mock('../catalog', async () => (await import('./service-harness.fixture')).catalogModule);
vi.mock('../discovery', async () => (await import('./service-harness.fixture')).discoveryModule);
vi.mock('../supervisor', async () => (await import('./service-harness.fixture')).supervisorModule);

import { ExtensionService } from '../service';

describe('ExtensionService tree children', () => {
    beforeEach(resetSupervisorHarness);

    it('recovers an expired branch handle with a current root snapshot', async () => {
        const service = new ExtensionService({
            ...observationIdentity,
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            extensionRoots: ['/extensions'],
            includeTestOnly: true,
            logger: new StructuredLogger(
                '/tmp/caxri-extension-service-test',
                'server-core',
                'error',
            ),
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
                context: { kind: 'no-session' },
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
            ...observationIdentity,
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            extensionRoots: ['/extensions'],
            includeTestOnly: true,
            logger: new StructuredLogger(
                '/tmp/caxri-extension-service-test',
                'server-core',
                'error',
            ),
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
                context: { kind: 'no-session' },
            }),
        ).resolves.toEqual({ items: [] });
        const treeRequests = supervisorHarness.requests.filter(
            ({ method }) => method === 'treeChildren',
        );
        expect(treeRequests).toHaveLength(2);
        expect(treeRequests.every(({ parameters }) => !parameters?.parentHandle)).toBe(true);
    });

    it('cancels instead of failing when the provider refreshes again during the root retry', async () => {
        const service = new ExtensionService({
            ...observationIdentity,
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            extensionRoots: ['/extensions'],
            includeTestOnly: true,
            logger: new StructuredLogger(
                '/tmp/caxri-extension-service-test',
                'server-core',
                'error',
            ),
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
        supervisorHarness.treeChildrenFailureCount = 2;

        await expect(
            service.treeChildren({
                viewId: 'publisher.fixture.tree',
                parentHandle: 'stale-handle',
                requestId: 'request-1',
                context: { kind: 'no-session' },
            }),
        ).rejects.toMatchObject({ code: 'CANCELLED' });
    });

    it('cancels a tree read when the active Session changes while the request is in flight', async () => {
        let active: { ownerProjectId?: string; sessionId?: string; workbenchProjectId?: string } = {
            ownerProjectId: 'project-1',
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
        };
        const service = new ExtensionService({
            ...observationIdentity,
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            extensionRoots: ['/extensions'],
            includeTestOnly: true,
            logger: new StructuredLogger(
                '/tmp/caxri-extension-service-test',
                'server-core',
                'error',
            ),
            activeContext: () => Promise.resolve(active),
            projectIds: () => Promise.resolve(['project-1', 'project-2']),
            projectStatus: () => Promise.resolve({ repositories: [], refreshedAt: 1 }),
            workspaceRequest: () => Promise.resolve(null),
        });
        await service.start();

        const pending = service.treeChildren({
            viewId: 'publisher.fixture.tree',
            requestId: 'stale-tree',
            context: { kind: 'session', sessionId: 'session-1', workbenchProjectId: 'project-1' },
        });
        await vi.waitFor(() =>
            expect(supervisorHarness.requests).toContainEqual(
                expect.objectContaining({ method: 'activate' }),
            ),
        );
        active = {
            ownerProjectId: 'project-2',
            sessionId: 'session-2',
            workbenchProjectId: 'project-2',
        };
        supervisorHarness.activation.resolve();

        await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(supervisorHarness.requests).not.toContainEqual(
            expect.objectContaining({ method: 'treeChildren' }),
        );
        await expect(
            service.treeChildren({
                viewId: 'publisher.fixture.tree',
                requestId: 'current-tree',
                context: {
                    kind: 'session',
                    sessionId: 'session-2',
                    workbenchProjectId: 'project-2',
                },
            }),
        ).resolves.toEqual({ items: [] });
        expect(
            supervisorHarness.requests.find(({ method }) => method === 'treeChildren')?.parameters
                ?.context,
        ).toEqual({ kind: 'session', sessionId: 'session-2', workbenchProjectId: 'project-2' });
    });
});

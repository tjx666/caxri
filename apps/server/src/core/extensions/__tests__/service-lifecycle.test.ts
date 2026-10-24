import { StructuredLogger } from '@caxri/system';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    observationIdentity,
    resetSupervisorHarness,
    sessionContextOf,
    supervisorHarness,
} from './service-harness.fixture';

vi.mock('../catalog', async () => (await import('./service-harness.fixture')).catalogModule);
vi.mock('../discovery', async () => (await import('./service-harness.fixture')).discoveryModule);
vi.mock('../supervisor', async () => (await import('./service-harness.fixture')).supervisorModule);

import { ExtensionService } from '../service';

describe('ExtensionService generation lifecycle', () => {
    beforeEach(resetSupervisorHarness);

    it('activates once for concurrent badge reads and rejects undeclared badge views', async () => {
        const logger = new StructuredLogger(
            '/tmp/caxri-extension-badge-test',
            'server-core',
            'error',
        );
        const service = new ExtensionService({
            ...observationIdentity,
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            extensionRoots: ['/extensions'],
            includeTestOnly: true,
            logger,
            sessionContext: sessionContextOf(
                () => ({
                    ownerProjectId: 'project-1',
                    sessionId: 'session-1',
                    workbenchProjectId: 'project-1',
                }),
                ['project-1'],
            ),
            projectIds: () => Promise.resolve(['project-1']),
            projectStatus: () => Promise.resolve({ repositories: [], refreshedAt: 1 }),
            workspaceRequest: () => Promise.resolve(null),
        });
        await service.start();
        supervisorHarness.viewOperationResult = {
            kind: 'count',
            count: 3,
            description: '3 changes',
        };
        const request = {
            viewId: 'publisher.fixture.tree',
            operation: 'badge.snapshot' as const,
            arguments: {},
            context: {
                kind: 'session' as const,
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
            },
        };
        const first = service.viewOperation({ ...request, requestId: 'badge-1' });
        const second = service.viewOperation({ ...request, requestId: 'badge-2' });
        await vi.waitFor(() =>
            expect(
                supervisorHarness.requests.filter(({ method }) => method === 'activate'),
            ).toHaveLength(1),
        );
        supervisorHarness.activation.resolve();
        expect(await Promise.all([first, second])).toEqual([
            { kind: 'count', count: 3, description: '3 changes' },
            { kind: 'count', count: 3, description: '3 changes' },
        ]);
        expect(
            supervisorHarness.requests.filter(({ method }) => method === 'activate'),
        ).toHaveLength(1);
        await expect(
            service.viewOperation({
                ...request,
                viewId: 'publisher.fixture.sourceControl',
                requestId: 'undeclared',
            }),
        ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
        await service.shutdown();
        await logger.flush();
    });

    it('cancels a controlled operation before activation when its Renderer scope is stale', async () => {
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
            sessionContext: sessionContextOf(
                () => ({
                    ownerProjectId: 'project-2',
                    sessionId: 'session-2',
                    workbenchProjectId: 'project-2',
                }),
                ['project-2'],
            ),
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
                sessionContext: sessionContextOf(() => active, ['project-1', 'project-2']),
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

    it('classifies superseded controlled reads as cancellation and superseded actions as a conflict', async () => {
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
            sessionContext: sessionContextOf(
                () => ({
                    ownerProjectId: 'project-1',
                    sessionId: 'session-1',
                    workbenchProjectId: 'project-1',
                }),
                ['project-1'],
            ),
            projectIds: () => Promise.resolve(['project-1']),
            projectStatus: () => Promise.resolve({ repositories: [], refreshedAt: 1 }),
            workspaceRequest: () => Promise.resolve(null),
        });
        await service.start();
        supervisorHarness.activation.resolve();
        supervisorHarness.viewOperationResult = Promise.reject(
            Object.assign(new Error('Source Control snapshot was superseded'), {
                code: 'GENERATION_EXPIRED',
            }),
        );

        await expect(
            service.viewOperation({
                viewId: 'publisher.fixture.sourceControl',
                operation: 'source.snapshot',
                arguments: { refresh: 0 },
                requestId: 'superseded-snapshot',
                context: {
                    kind: 'session',
                    sessionId: 'session-1',
                    workbenchProjectId: 'project-1',
                },
            }),
        ).rejects.toMatchObject({
            code: 'CANCELLED',
            message: 'Source Control snapshot was superseded',
        });

        supervisorHarness.viewOperationResult = Promise.reject(
            Object.assign(new Error('Source Control action expired'), {
                code: 'GENERATION_EXPIRED',
            }),
        );
        await expect(
            service.viewOperation({
                viewId: 'publisher.fixture.sourceControl',
                operation: 'source.action',
                arguments: { actionId: 'stale-action', revision: '1' },
                requestId: 'expired-action',
                context: {
                    kind: 'session',
                    sessionId: 'session-1',
                    workbenchProjectId: 'project-1',
                },
            }),
        ).rejects.toMatchObject({
            // Not CANCELLED: the Renderer must learn that the click did nothing, and re-resolves it on the fresh model.
            code: 'CONFLICT',
            message: 'Source Control changed before the action ran',
        });

        const pending = Promise.withResolvers<unknown>();
        supervisorHarness.viewOperationResult = pending.promise;
        const retiredGeneration = service.viewOperation({
            viewId: 'publisher.fixture.sourceControl',
            operation: 'source.snapshot',
            arguments: { refresh: 1 },
            requestId: 'retired-generation-snapshot',
            context: {
                kind: 'session',
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
            },
        });
        await vi.waitFor(() =>
            expect(
                supervisorHarness.requests.some(
                    (request) =>
                        request.method === 'viewOperation' &&
                        request.parameters?.requestId === 'retired-generation-snapshot',
                ),
            ).toBe(true),
        );
        for (const listener of supervisorHarness.exitListeners) listener(86);
        pending.resolve({
            revision: '2',
            title: 'Source Control',
            accessibilityLabel: 'Repositories',
            modeAccessibilityLabel: 'Source control mode',
            modes: [],
            selectedModeId: 'default',
            refreshAction: {
                id: 'refresh',
                label: 'Refresh',
                icon: { kind: 'theme', id: 'refresh' },
                command: { id: 'publisher.fixture.refresh' },
            },
            providers: [],
            emptyMessage: 'No repositories.',
        });
        await expect(retiredGeneration).rejects.toMatchObject({
            code: 'CANCELLED',
            message: 'View provider generation expired',
        });
    });

    it('does not let a rejected retired activation overwrite the crash generation', async () => {
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
            sessionContext: sessionContextOf(() => ({}), []),
            projectIds: () => Promise.resolve([]),
            projectStatus: () => Promise.resolve({ repositories: [], refreshedAt: 1 }),
            workspaceRequest: () => Promise.resolve(null),
        });
        await service.start();

        const pending = service.treeChildren({
            viewId: 'publisher.fixture.tree',
            requestId: 'request-1',
            context: { kind: 'no-session' },
        });
        await vi.waitFor(() =>
            expect(supervisorHarness.requests).toContainEqual(
                expect.objectContaining({ method: 'activate' }),
            ),
        );
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
            sessionContext: sessionContextOf(() => ({}), []),
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

    it('validates a controlled view result against its exact operation schema', async () => {
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
            sessionContext: sessionContextOf(() => ({}), []),
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

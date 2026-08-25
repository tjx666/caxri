import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    ExtensionHostApiRequest,
    ExtensionHostRegistration,
} from '../../../shared/extension-host-protocol';
import { StructuredLogger } from '../../../shared/node/logger';

const harness = vi.hoisted(() => ({
    capabilities: ['files.read', 'files.write', 'git.read', 'git.write'],
    requestApi: undefined as ((request: ExtensionHostApiRequest) => Promise<unknown>) | undefined,
    registrations: undefined as (() => ExtensionHostRegistration[]) | undefined,
}));

vi.mock('../catalog', () => ({
    buildViewCatalog: ({ revision }: { revision: number }) =>
        Promise.resolve({
            revision,
            containers: [],
            views: [],
            commands: [],
            extensions: [
                {
                    id: 'publisher.fixture',
                    version: '1.0.0',
                    generation: 1,
                    lifecycle: 'discovered',
                },
            ],
        }),
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
                        caxri: {
                            capabilities: harness.capabilities,
                        },
                        contributes: {
                            viewsContainers: { secondarySidebar: [], panel: [] },
                            views: {},
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
        constructor(options: {
            registrations(): ExtensionHostRegistration[];
            requestApi(request: ExtensionHostApiRequest): Promise<unknown>;
        }) {
            harness.registrations = () => options.registrations();
            harness.requestApi = (request) => options.requestApi(request);
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

        shutdown() {
            return Promise.resolve();
        }
    },
}));

import { ExtensionService } from '../service';

function apiRequest(
    registration: ExtensionHostRegistration,
    operation: Extract<
        ExtensionHostApiRequest,
        { method: 'workspace.request' }
    >['params']['operation'],
    arguments_: unknown,
): ExtensionHostApiRequest {
    return {
        type: 'api-request',
        id: crypto.randomUUID(),
        extensionId: registration.extensionId,
        generation: registration.generation,
        apiToken: registration.apiToken,
        method: 'workspace.request',
        params: { operation, arguments: arguments_ },
    };
}

describe('ExtensionService workspace API authority', () => {
    let active = {
        ownerProjectId: 'project-1',
        workbenchProjectId: 'project-1',
        sessionId: 'session-1',
    };
    let projectIds = ['project-1'];
    let workspaceRequest = vi.fn<(operation: string, parameters: unknown) => Promise<unknown>>();

    beforeEach(async () => {
        harness.capabilities = ['files.read', 'files.write', 'git.read', 'git.write'];
        active = {
            ownerProjectId: 'project-1',
            workbenchProjectId: 'project-1',
            sessionId: 'session-1',
        };
        projectIds = ['project-1'];
        workspaceRequest = vi.fn(() => Promise.resolve([]));
        harness.requestApi = undefined;
        harness.registrations = undefined;
        const service = new ExtensionService({
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            extensionRoots: ['/extensions'],
            includeTestOnly: true,
            logger: new StructuredLogger('/tmp/caxri-extension-workspace-test', 'host', 'error'),
            activeContext: () => Promise.resolve(active),
            projectIds: () => Promise.resolve(projectIds),
            projectStatus: () => Promise.resolve({ repositories: [], refreshedAt: 1 }),
            workspaceRequest,
        });
        await service.start();
    });

    it('injects the active Session and preserves Runtime path denial', async () => {
        const registration = harness.registrations!()[0];
        await harness.requestApi!(
            apiRequest(registration, 'files.list', {
                directory: '/project',
                sessionId: 'untrusted-session',
            }),
        );
        expect(workspaceRequest).toHaveBeenCalledWith(
            'files.list',
            {
                directory: '/project',
                sessionId: 'session-1',
            },
            { sessionId: 'session-1', workbenchProjectId: 'project-1' },
        );

        const denied = Object.assign(new Error('Path is outside the Project'), {
            code: 'PATH_DENIED',
        });
        workspaceRequest.mockRejectedValueOnce(denied);
        await expect(
            harness.requestApi!(apiRequest(registration, 'files.list', { directory: '/outside' })),
        ).rejects.toBe(denied);
    });

    it('denies undeclared capabilities and cross-Project operation control', async () => {
        const registration = harness.registrations!()[0];
        await expect(
            harness.requestApi!({
                type: 'api-request',
                id: crypto.randomUUID(),
                extensionId: registration.extensionId,
                generation: registration.generation,
                apiToken: registration.apiToken,
                method: 'workspace.getProjectStatus',
                params: {},
            }),
        ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

        workspaceRequest.mockResolvedValueOnce({
            id: 'operation-1',
            sessionId: 'session-2',
            workbenchProjectId: 'project-2',
            kind: 'create',
            phase: 'completed',
            startedAt: 1,
            updatedAt: 2,
            input: { directory: '/project', name: 'a.txt', kind: 'file' },
            result: { name: 'a.txt', path: '/project/a.txt', kind: 'file' },
        });
        await expect(
            harness.requestApi!(
                apiRequest(registration, 'files.operation.cancel', {
                    operationId: 'operation-1',
                }),
            ),
        ).rejects.toMatchObject({ code: 'PROJECT_SCOPE_DENIED' });
        expect(workspaceRequest).toHaveBeenCalledTimes(1);
        expect(workspaceRequest).toHaveBeenCalledWith(
            'files.operation.get',
            { operationId: 'operation-1' },
            { sessionId: 'session-1', workbenchProjectId: 'project-1' },
        );
    });

    it('injects the active Session and preserves Runtime Git authorization denial', async () => {
        const registration = harness.registrations!()[0];
        const denied = Object.assign(new Error('Repository is outside approved Projects'), {
            code: 'PATH_DENIED',
        });
        workspaceRequest.mockRejectedValueOnce(denied);

        await expect(
            harness.requestApi!(
                apiRequest(registration, 'git.sync', {
                    repositoryId: 'unapproved-repository',
                    sessionId: 'untrusted-session',
                }),
            ),
        ).rejects.toBe(denied);
        expect(workspaceRequest).toHaveBeenCalledWith(
            'git.sync',
            {
                repositoryId: 'unapproved-repository',
                sessionId: 'session-1',
            },
            { sessionId: 'session-1', workbenchProjectId: 'project-1' },
        );
    });

    it('allows exactly-once recovery from another Session in the active Project', async () => {
        const registration = harness.registrations!()[0];
        const operation = {
            id: 'operation-1',
            sessionId: 'session-2',
            workbenchProjectId: 'project-1',
            kind: 'create',
            phase: 'completed',
            startedAt: 1,
            updatedAt: 2,
            input: { directory: '/project', name: 'a.txt', kind: 'file' },
            result: { name: 'a.txt', path: '/project/a.txt', kind: 'file' },
        };
        workspaceRequest.mockResolvedValueOnce(operation).mockResolvedValueOnce({
            ...operation,
            phase: 'canceled',
        });

        await expect(
            harness.requestApi!(
                apiRequest(registration, 'files.operation.cancel', {
                    operationId: operation.id,
                }),
            ),
        ).resolves.toMatchObject({ id: operation.id, phase: 'canceled' });
        expect(workspaceRequest).toHaveBeenNthCalledWith(
            2,
            'files.operation.cancel',
            { operationId: operation.id },
            { sessionId: 'session-1', workbenchProjectId: 'project-1' },
        );
    });

    it('authorizes durable operation recovery against the selected Workbench Root', async () => {
        active = {
            ownerProjectId: 'project-owner',
            workbenchProjectId: 'project-worktree',
            sessionId: 'session-1',
        };
        projectIds = ['project-owner', 'project-worktree'];
        const registration = harness.registrations!()[0];
        const operation = {
            id: 'operation-worktree',
            sessionId: 'session-2',
            workbenchProjectId: 'project-worktree',
            kind: 'create',
            phase: 'completed',
            startedAt: 1,
            updatedAt: 2,
            input: { directory: '/worktree', name: 'a.txt', kind: 'file' },
            result: { name: 'a.txt', path: '/worktree/a.txt', kind: 'file' },
        };
        workspaceRequest.mockResolvedValueOnce([operation]);

        await expect(
            harness.requestApi!(apiRequest(registration, 'files.operation.list', {})),
        ).resolves.toEqual([operation]);
    });

    it('requires both the owning Project and Workbench Root to remain granted', async () => {
        active = {
            ownerProjectId: 'project-owner',
            workbenchProjectId: 'project-worktree',
            sessionId: 'session-1',
        };
        projectIds = ['project-worktree'];
        const registration = harness.registrations!()[0];

        await expect(
            harness.requestApi!(apiRequest(registration, 'files.list', {})),
        ).rejects.toMatchObject({ code: 'PROJECT_SCOPE_DENIED' });
        expect(workspaceRequest).not.toHaveBeenCalled();
    });

    it('rejects a result when the active Session changes in flight', async () => {
        const registration = harness.registrations!()[0];
        const pending = Promise.withResolvers<unknown>();
        workspaceRequest.mockReturnValueOnce(pending.promise);
        const request = harness.requestApi!(apiRequest(registration, 'files.list', {}));
        await new Promise((resolve) => setImmediate(resolve));
        active = {
            ownerProjectId: 'project-1',
            workbenchProjectId: 'project-1',
            sessionId: 'session-2',
        };
        pending.resolve([]);
        await expect(request).rejects.toMatchObject({ code: 'GENERATION_EXPIRED' });
    });

    it('rejects a read when the selected Workbench Root changes in flight', async () => {
        const registration = harness.registrations!()[0];
        const pending = Promise.withResolvers<unknown>();
        workspaceRequest.mockReturnValueOnce(pending.promise);
        const request = harness.requestApi!(apiRequest(registration, 'git.summary', {}));
        await new Promise((resolve) => setImmediate(resolve));
        active = { ...active, workbenchProjectId: 'project-2' };
        projectIds = ['project-1', 'project-2'];
        pending.resolve({ isRepository: false, repositories: [] });
        await expect(request).rejects.toMatchObject({ code: 'GENERATION_EXPIRED' });
    });

    it('returns an authoritative write result after the active context changes', async () => {
        const registration = harness.registrations!()[0];
        const pending = Promise.withResolvers<unknown>();
        workspaceRequest.mockReturnValueOnce(pending.promise);
        const request = harness.requestApi!(
            apiRequest(registration, 'files.copy', {
                directory: '/project',
                path: '/project/source.txt',
            }),
        );
        await new Promise((resolve) => setImmediate(resolve));
        active = { ...active, sessionId: 'session-2' };
        pending.resolve({
            kind: 'file',
            name: 'source copy.txt',
            path: '/project/source copy.txt',
        });
        await expect(request).resolves.toEqual({
            kind: 'file',
            name: 'source copy.txt',
            path: '/project/source copy.txt',
        });
    });

    it('preserves the structured Status response when there is no active Session', async () => {
        harness.capabilities = [
            'files.read',
            'files.write',
            'git.read',
            'git.write',
            'projects.read',
        ];
        const service = new ExtensionService({
            appVersion: '0.0.17',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            extensionRoots: ['/extensions'],
            includeTestOnly: true,
            logger: new StructuredLogger('/tmp/caxri-extension-workspace-test', 'host', 'error'),
            activeContext: () => Promise.resolve({}),
            projectIds: () => Promise.resolve(projectIds),
            projectStatus: () => Promise.resolve({ repositories: [], refreshedAt: 1 }),
            workspaceRequest,
        });
        await service.start();
        const registration = harness.registrations!()[0];

        await expect(
            harness.requestApi!({
                type: 'api-request',
                id: crypto.randomUUID(),
                extensionId: registration.extensionId,
                generation: registration.generation,
                apiToken: registration.apiToken,
                method: 'workspace.getProjectStatus',
                params: {},
            }),
        ).resolves.toMatchObject({
            repositories: [],
            error: 'No active Session',
        });
        expect(workspaceRequest).not.toHaveBeenCalled();
    });
});

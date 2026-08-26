import type { AppSettings, ExtensionCapability } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    ExtensionHostApiRequest,
    ExtensionHostRegistration,
} from '../../../extension-host/protocol';

const harness = vi.hoisted(() => ({
    capabilities: [] as ExtensionCapability[],
    configurationDependencies: [] as string[],
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
                        engines: { caxri: '^0.0.18' },
                        caxri: { capabilities: harness.capabilities },
                        contributes: {
                            viewsContainers: { secondarySidebar: [], panel: [] },
                            views: {
                                'publisher.fixture': [
                                    {
                                        id: 'publisher.fixture.sourceControl',
                                        name: 'Source Control',
                                        type: 'source-control',
                                        configurationDependencies:
                                            harness.configurationDependencies,
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

const defaultApiContext = {
    kind: 'session' as const,
    sessionId: 'session-1',
    workbenchProjectId: 'project-1',
};

function apiRequest(
    registration: ExtensionHostRegistration,
    operation: Extract<
        ExtensionHostApiRequest,
        { method: 'workspace.request' }
    >['params']['operation'],
    arguments_: unknown,
    context = defaultApiContext,
): ExtensionHostApiRequest {
    return {
        type: 'api-request',
        id: crypto.randomUUID(),
        extensionId: registration.extensionId,
        generation: registration.generation,
        apiToken: registration.apiToken,
        method: 'workspace.request',
        params: { operation, arguments: arguments_, context },
    };
}

describe('ExtensionService Git workspace API authority', () => {
    let active: { ownerProjectId: string; sessionId: string; workbenchProjectId: string };
    let workspaceRequest: ReturnType<
        typeof vi.fn<(operation: string, parameters: unknown) => Promise<unknown>>
    >;

    beforeEach(() => {
        active = {
            ownerProjectId: 'project-1',
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
        };
        workspaceRequest = vi.fn(() => Promise.resolve({ isRepository: false, repositories: [] }));
        harness.requestApi = undefined;
        harness.registrations = undefined;
        harness.configurationDependencies = [];
    });

    async function start(
        capabilities: ExtensionCapability[] = ['git.read', 'git.write'],
        options: { configurationDependencies?: string[]; settings?: Partial<AppSettings> } = {},
    ) {
        harness.capabilities = capabilities;
        harness.configurationDependencies = options.configurationDependencies ?? [];
        const service = new ExtensionService({
            appVersion: '0.0.18',
            commit: 'test',
            extensionHostPath: '/out/main/extension-host.js',
            extensionRoots: ['/extensions'],
            includeTestOnly: true,
            logger: new StructuredLogger('/tmp/caxri-extension-workspace-test', 'host', 'error'),
            activeContext: () => Promise.resolve(active),
            projectIds: () => Promise.resolve(['project-1']),
            projectStatus: () => Promise.resolve({ repositories: [], refreshedAt: 1 }),
            settings: () => Promise.resolve(options.settings as AppSettings),
            workspaceRequest,
        });
        await service.start();
        return harness.registrations!()[0];
    }

    it('injects the active Session and preserves Runtime Git authorization denial', async () => {
        const registration = await start();
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
            { repositoryId: 'unapproved-repository', sessionId: 'session-1' },
            { sessionId: 'session-1', workbenchProjectId: 'project-1' },
        );
    });

    it('denies a Git mutation when the extension declared only read capability', async () => {
        const registration = await start(['git.read']);

        await expect(
            harness.requestApi!(
                apiRequest(registration, 'git.sync', { repositoryId: 'repository-1' }),
            ),
        ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
        expect(workspaceRequest).not.toHaveBeenCalled();
    });

    it('rejects a read result when the active Session changes in flight', async () => {
        const pending = Promise.withResolvers<unknown>();
        workspaceRequest.mockImplementation(() => pending.promise);
        const registration = await start();
        const request = harness.requestApi!(
            apiRequest(registration, 'git.summary', { refresh: 0 }),
        );
        await vi.waitFor(() => expect(workspaceRequest).toHaveBeenCalledOnce());

        active = {
            ownerProjectId: 'project-2',
            sessionId: 'session-2',
            workbenchProjectId: 'project-2',
        };
        pending.resolve({ isRepository: false, repositories: [] });

        await expect(request).rejects.toMatchObject({ code: 'GENERATION_EXPIRED' });
    });

    it('returns only configuration keys declared by a settings-capable extension view', async () => {
        const registration = await start(['settings.read'], {
            configurationDependencies: ['git.fetchGitHubAvatars'],
            settings: { 'git.fetchGitHubAvatars': true },
        });

        await expect(
            harness.requestApi!({
                type: 'api-request',
                id: crypto.randomUUID(),
                extensionId: registration.extensionId,
                generation: registration.generation,
                apiToken: registration.apiToken,
                method: 'workspace.getConfiguration',
                params: { key: 'git.fetchGitHubAvatars' },
            }),
        ).resolves.toBe(true);
    });

    it('denies undeclared configuration keys even with settings.read', async () => {
        const registration = await start(['settings.read'], {
            configurationDependencies: ['git.fetchGitHubAvatars'],
            settings: { 'git.fetchGitHubAvatars': true },
        });

        await expect(
            harness.requestApi!({
                type: 'api-request',
                id: crypto.randomUUID(),
                extensionId: registration.extensionId,
                generation: registration.generation,
                apiToken: registration.apiToken,
                method: 'workspace.getConfiguration',
                params: { key: 'terminal.fontSize' },
            }),
        ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    });
});

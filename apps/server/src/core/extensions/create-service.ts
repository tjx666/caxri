import type { StructuredLogger } from '@caxri/system';

import type { ControlServer } from '../control-server';
import type { ServerDesktopRouter } from '../desktop-router';
import type { ServerDomainService } from '../domain-service';
import { ExtensionService } from './service';
import { publishExtensionViewEvents } from './view-events';
import { createExtensionWorkspaceRequest } from './workspace-bridge';

export interface CreateExtensionServiceOptions {
    appVersion: string;
    bootId: string;
    buildId: string;
    commit: string;
    /**
     * Leave the Extension Host child unforked until {@link ExtensionService.startHost} or the first request that needs
     * it; see {@link ExtensionService.start}.
     */
    deferHostStart?: boolean;
    desktopRouter(): ServerDesktopRouter | undefined;
    domainService: ServerDomainService;
    executable?: string;
    extensionHostPath?: string;
    extensionRoots?: string[];
    includeTestExtensions?: boolean;
    logger: StructuredLogger;
    server(): ControlServer | undefined;
    serverId: string;
    userDataPath: string;
}

/**
 * Composes the shared Extension Host and its Core-owned bridges without making the Server Core entrypoint own Extension
 * discovery, workspace projection, or view-event wiring details.
 */
export async function createExtensionService(
    options: CreateExtensionServiceOptions,
): Promise<ExtensionService | undefined> {
    if (!options.extensionHostPath || !options.extensionRoots) return;
    const service = new ExtensionService({
        appVersion: options.appVersion,
        bootId: options.bootId,
        buildId: options.buildId,
        commit: options.commit,
        executable: options.executable,
        extensionHostPath: options.extensionHostPath,
        extensionRoots: options.extensionRoots,
        includeTestOnly: options.includeTestExtensions ?? false,
        logger: options.logger,
        serverId: options.serverId,
        userDataPath: options.userDataPath,
        projectIds: async () =>
            (await options.domainService.request('app.activeContext')).projectIds,
        sessionContext: (sessionId) =>
            options.domainService.request('app.sessionContext', { sessionId }),
        projectStatus: (sessionId, refreshToken) =>
            options.domainService.request('projectStatus.summary', {
                sessionId,
                ...(refreshToken && { refreshToken }),
            }),
        settings: async () => (await options.domainService.request('settings.get')).value,
        workspaceRequest: createExtensionWorkspaceRequest({
            desktopRouter: () => options.desktopRouter(),
            domainService: options.domainService,
        }),
    });
    service.onCatalogChanged((payload) =>
        options.server()?.broadcast({ event: 'viewContainers.catalogChanged', payload }),
    );
    publishExtensionViewEvents(service, () => options.server());
    await service.start({ deferHost: options.deferHostStart ?? false });
    return service;
}

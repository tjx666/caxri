import process from 'node:process';

import type { MethodResult } from '@caxri/protocol';
import { CAXRI_PROTOCOL_VERSION } from '@caxri/protocol';

import type { ServerDesktopRouter } from './desktop-router';
import type { ServerDomainService } from './domain-service';

export interface HostStatusDependencies {
    buildId?: string;
    clientCount: () => number;
    desktopRouter: () => ServerDesktopRouter | undefined;
    domainService: ServerDomainService;
    profileId: string;
    startedAt: number;
    version: string;
}

/**
 * Builds the `host.status` result: this Host's identity and build, plus the live PTY count and the latest database
 * rebuild (absent when none happened) from the domain process, which owns the database.
 */
export async function readHostStatus(
    dependencies: HostStatusDependencies,
): Promise<MethodResult<'host.status'>> {
    const health = await dependencies.domainService.request('app.health');
    return {
        profileId: dependencies.profileId,
        version: dependencies.version,
        ...(dependencies.buildId && { buildId: dependencies.buildId }),
        ...(process.env.CAXRI_GIT_COMMIT && { commit: process.env.CAXRI_GIT_COMMIT }),
        pid: process.pid,
        startedAt: dependencies.startedAt,
        clientCount: dependencies.clientCount(),
        activePtyCount: health.activePtyCount,
        protocolVersion: CAXRI_PROTOCOL_VERSION,
        protocolCompatible: true,
        desktop: (await dependencies.desktopRouter()?.status()) ?? { state: 'offline' },
        ...(health.lastDatabaseRebuild && { lastDatabaseRebuild: health.lastDatabaseRebuild }),
    };
}

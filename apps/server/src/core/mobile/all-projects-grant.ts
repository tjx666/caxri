import { logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { ServerDomainService } from '../domain-service';
import type { MobileDeviceRegistry } from './device-registry';

/**
 * Keeps devices paired with "All Projects" holding every top-level Project the Workbench shows. A Project can be added
 * by many paths (Desktop, CLI, an import, a phone), and each announces a full `state.changed`, so the follower reads
 * the Project list after any such event, after a device change, and once at attach, instead of hooking each creation
 * path. Runs are serialized and coalesced: a trigger during a run schedules exactly one more.
 */
export function createAllProjectsGrantFollower(
    registry: Pick<MobileDeviceRegistry, 'grantAllProjects'>,
    domainService: Pick<ServerDomainService, 'request'>,
    logger: Pick<StructuredLogger, 'write'> | undefined,
): { follow: () => void; settled: () => Promise<void> } {
    let isRunning = false;
    /**
     * Triggers received, and the count the last completed pass had seen when it started.
     */
    let requested = 0;
    let handled = 0;
    let lastCapped = 0;
    let tail = Promise.resolve();
    const log = (outcome: 'capped' | 'failed' | 'granted', granted: number, capped: number) =>
        logger?.write(
            outcome === 'granted' ? 'info' : 'warn',
            logEventCatalog.mobileGateway.allProjectsGrant,
            { fields: { capped, granted, outcome } },
        );
    const grantOnce = async (): Promise<void> => {
        try {
            const { projects } = await domainService.request('project.list', {});
            const result = await registry.grantAllProjects(
                projects
                    // The in-process handler answers full Project records; the union type only narrows per view.
                    .filter(
                        (project) =>
                            !('ownerProjectId' in project) || project.ownerProjectId === undefined,
                    )
                    .map(({ id }) => id),
            );
            if (result.granted > 0)
                log(result.capped > 0 ? 'capped' : 'granted', result.granted, result.capped);
            else if (result.capped !== lastCapped) log('capped', 0, result.capped);
            lastCapped = result.capped;
        } catch {
            log('failed', 0, 0);
        }
    };
    /**
     * Reruns once per batch of triggers that arrived during the previous pass, serialized rather than concurrent.
     */
    const run = async (): Promise<void> => {
        const seen = requested;
        await grantOnce();
        handled = seen;
        if (handled < requested) return run();
        isRunning = false;
    };
    return {
        follow: () => {
            requested += 1;
            if (isRunning) return;
            isRunning = true;
            tail = run();
        },
        settled: () => tail,
    };
}

import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { ServerDomainService } from './domain-service';
import type { MutationAdmission } from './mutation-admission';
import type { CommandStopFallbackReference } from './server-core-control-callbacks';

export interface HostStopDependencies {
    commandStopFallbackReference: CommandStopFallbackReference;
    domainService: ServerDomainService;
    logger: StructuredLogger;
    mutationAdmission: MutationAdmission;
    stop: (reason?: string) => Promise<void>;
}

/**
 * Accepts a `host.stop` command: closes mutation admission, waits for every running mutation (Extension commands and
 * `source.action` included) to settle, then refuses while PTYs are live unless the caller confirmed them. Admission
 * reopens when the stop is refused. An accepted stop exits once `onReplyFlushed` sees its reply, or through the armed
 * fallback when the requesting client disconnects first.
 */
export async function acceptHostStop(
    dependencies: HostStopDependencies,
    parameters: { confirmLivePtys: boolean },
): Promise<{ stopping: true; activePtyCount: number }> {
    const { commandStopFallbackReference, domainService, logger, mutationAdmission, stop } =
        dependencies;
    if (mutationAdmission.isClosed)
        throw new CaxriError('CONFLICT', 'Host stop is already in progress');
    mutationAdmission.close();
    let isAccepted = false;
    try {
        await mutationAdmission.waitForDrain();
        const health = await domainService.request('app.health');
        if (!parameters.confirmLivePtys && health.activePtyCount > 0)
            throw new CaxriError(
                'CONFLICT',
                'Host has live PTYs; retry with explicit confirmation',
            );
        isAccepted = true;
        /**
         * Stop even if the requesting client disconnects before its reply can flush.
         */
        commandStopFallbackReference.current ??= setImmediate(async () => {
            try {
                await stop('command');
            } catch (error) {
                logger.write('error', logEventCatalog.serverCore.stopFailed, {
                    fields: { message: error instanceof Error ? error.message : String(error) },
                });
            }
        });
        commandStopFallbackReference.current.unref();
        return { stopping: true, activePtyCount: health.activePtyCount };
    } finally {
        if (!isAccepted) mutationAdmission.reopen();
    }
}

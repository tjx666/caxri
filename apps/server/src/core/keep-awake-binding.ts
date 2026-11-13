import type { StructuredLogger } from '@caxri/system';

import type { ServerDomainService } from './domain-service';
import type { KeepAwakeController } from './keep-awake';
import { createKeepAwakeController } from './keep-awake';

/**
 * Binds the keep-awake hold to Server Core's domain service: demand comes from `power.keepAwakeWhileAgentsWork` and
 * `session.workSummary`, and every state or settings change re-evaluates it. It evaluates once right away, so Agents
 * still working from before a Server restart get the hold before anything changes, and releases the hold as soon as
 * Server Core starts stopping. See docs/unattended-mode.md.
 */
export function startServerKeepAwake(options: {
    domainService: ServerDomainService;
    logger: Pick<StructuredLogger, 'write'>;
    /**
     * Resolves once Server Core starts stopping.
     */
    stopping: Promise<void>;
}): Pick<KeepAwakeController, 'status'> {
    const { domainService } = options;
    const controller = createKeepAwakeController({
        logger: options.logger,
        readDemand: async () => {
            const [settings, summary] = await Promise.all([
                domainService.request('settings.get'),
                domainService.request('session.workSummary', {}),
            ]);
            return {
                isEnabled: settings.value['power.keepAwakeWhileAgentsWork'],
                working: summary.working,
                usageWaiting: summary.usageWaiting,
            };
        },
    });
    const unsubscribe = domainService.onEvent((event) => {
        if (event.event === 'state.changed' || event.event === 'settings.changed')
            controller.schedule();
    });
    void (async () => {
        await options.stopping;
        unsubscribe();
        controller.stop();
    })();
    controller.schedule();
    return { status: () => controller.status() };
}

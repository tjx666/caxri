import type { ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { ServerDomainService } from '../domain-service';
import { routeActiveContextChange, routeExtensionDomainEvent } from './domain-events';
import type { ExtensionService } from './service';

interface ExtensionEventRouterOptions {
    domainService: ServerDomainService;
    extensionService(): ExtensionService | undefined;
    /**
     * Whether Server Core is shutting down; refreshes emitted after the Extension Host enters teardown are skipped.
     */
    isStopping(): boolean;
    logger: StructuredLogger;
    /**
     * Whether a paired phone follows the Session's extension views.
     */
    watchesExtensionViews(sessionId: string): boolean;
}

/**
 * Wires domain events and focus moves into the Extension Host as best-effort refreshes: a failure is logged, never
 * thrown into event delivery. Only Sessions a Desktop window shows or a phone follows are refreshed; an unsettled
 * presence (Desktop has not reported its windows) keeps every Session watched, because an empty set would then only
 * mean "not reported".
 */
export function createExtensionEventRouter(options: ExtensionEventRouterOptions) {
    const { domainService, logger } = options;
    const logFailure = (error: unknown): void =>
        logger.write('error', logEventCatalog.extensionHost.contextRefreshFailed, {
            fields: { message: error instanceof Error ? error.message : String(error) },
        });
    const isSessionWatched = (sessionId: string): boolean => {
        const visible = domainService.visibleSessionIds();
        return !visible || visible.has(sessionId) || options.watchesExtensionViews(sessionId);
    };
    return {
        activeContextChanged: (): void => {
            if (options.isStopping()) return;
            // eslint-disable-next-line unicorn/prefer-await -- a listener cannot await a best-effort refresh
            routeActiveContextChange(options.extensionService(), domainService).catch(logFailure);
        },
        domainEvent: (event: ServerEvent): void => {
            if (options.isStopping()) return;
            const routing = routeExtensionDomainEvent(
                options.extensionService(),
                domainService,
                event,
                {
                    isSessionWatched,
                    onFanout: ({ named, notified }) =>
                        logger.write('debug', logEventCatalog.extensionHost.gitRefreshFanout, {
                            fields: { named, notified, skipped: named - notified },
                        }),
                },
            );
            // eslint-disable-next-line unicorn/prefer-await -- event delivery cannot await a best-effort refresh
            routing.catch(logFailure);
        },
    };
}

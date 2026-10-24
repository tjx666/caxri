import type {
    ExtensionViewEventContext,
    FullStateChangeReason,
    ServerEvent,
} from '@caxri/protocol';

import type { ServerDomainService } from '../../core/domain-service';
import type { ExtensionService } from './service';
import { toExtensionViewEventContext } from './service-events';

type DomainContextReader = Pick<ServerDomainService, 'request'>;

/**
 * Full state changes that can move the selected Session or its Workbench Root.
 */
const ACTIVE_CONTEXT_REASONS: ReadonlySet<FullStateChangeReason> = new Set([
    'session.select',
    'session.create',
    'session.delete',
    'session.workbenchRoot',
]);

async function readActiveExtensionContext(
    domainService: DomainContextReader,
): Promise<ExtensionViewEventContext> {
    return toExtensionViewEventContext(await domainService.request('app.activeContext'));
}

/**
 * Pushes the current active context to the Extension Host after it moved without a `state.changed` event, for example
 * when window focus moves between two windows showing different Sessions.
 */
export async function routeActiveContextChange(
    extensionService: ExtensionService | undefined,
    domainService: DomainContextReader,
): Promise<void> {
    if (!extensionService) return;
    await extensionService.activeContextChanged(await readActiveExtensionContext(domainService));
}

async function readSessionExtensionContext(
    domainService: DomainContextReader,
    sessionId: string,
): Promise<ExtensionViewEventContext> {
    return toExtensionViewEventContext(
        await domainService.request('app.sessionContext', { sessionId }),
    );
}

/**
 * Routes domain invalidations into the Extension Host with the exact scope that produced them: every Session a Git or
 * Status change names, not only the focused window's, because a second window or a phone may be showing any of them.
 * Server Core does not synthesize a scope for an unrelated event, and a Session that is gone or hidden is skipped.
 */
export async function routeExtensionDomainEvent(
    extensionService: ExtensionService | undefined,
    domainService: DomainContextReader,
    event: ServerEvent,
): Promise<void> {
    if (!extensionService) return;
    if (event.event !== 'projectStatus.changed' && event.event !== 'git.changed') {
        // Record updates stream with every Terminal and Agent state change and never move the active context.
        if (
            event.event !== 'state.changed' ||
            event.payload.kind !== 'full' ||
            !ACTIVE_CONTEXT_REASONS.has(event.payload.reason)
        )
            return;
        await extensionService.activeContextChanged(
            await readActiveExtensionContext(domainService),
        );
        return;
    }
    if (event.event === 'projectStatus.changed') {
        const context = await readSessionExtensionContext(domainService, event.payload.sessionId);
        if (context.kind === 'session') await extensionService.projectStatusChanged(context);
        return;
    }
    // Each named Session refreshes its own view scope independently, so the scopes are notified concurrently.
    const sessionIds = [...new Set(event.payload.sessionIds)];
    await Promise.all(
        sessionIds.map(async (sessionId) => {
            const context = await readSessionExtensionContext(domainService, sessionId);
            if (context.kind === 'session') await extensionService.gitChanged(context);
        }),
    );
}

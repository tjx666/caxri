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

export async function readActiveExtensionContext(
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

/**
 * Routes domain invalidations into the Extension Host with the exact scope that produced them. Server Core does not
 * synthesize an active-root scope for an unrelated Git or Status event, which would make a hidden view refresh the
 * wrong Session after a context switch.
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
    const context = await readActiveExtensionContext(domainService);
    if (event.event === 'projectStatus.changed') {
        if (context.kind !== 'session' || context.sessionId !== event.payload.sessionId) return;
        await extensionService.projectStatusChanged(context);
        return;
    }
    if (context.kind !== 'session' || !event.payload.sessionIds.includes(context.sessionId)) return;
    await extensionService.gitChanged(context);
}

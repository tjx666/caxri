import type { ExtensionViewEventContext, ServerEvent } from '@caxri/protocol';

import type { ServerDomainService } from '../../core/domain-service';
import type { ExtensionService } from './service';
import { toExtensionViewEventContext } from './service-events';
import { extensionActiveContext } from './workspace-bridge';

type DomainBootstrapReader = Pick<ServerDomainService, 'request'>;

export async function readActiveExtensionContext(
    domainService: DomainBootstrapReader,
): Promise<ExtensionViewEventContext> {
    return toExtensionViewEventContext(
        extensionActiveContext(await domainService.request('app.bootstrap')),
    );
}

/**
 * Routes domain invalidations into the Extension Host with the exact scope that produced them. Server Core does not
 * synthesize an active-root scope for an unrelated Git or Status event, which would make a hidden view refresh the
 * wrong Session after a context switch.
 */
export async function routeExtensionDomainEvent(
    extensionService: ExtensionService | undefined,
    domainService: DomainBootstrapReader,
    event: ServerEvent,
): Promise<void> {
    if (!extensionService) return;
    if (
        event.event !== 'projectStatus.changed' &&
        event.event !== 'git.changed' &&
        event.event !== 'state.changed'
    )
        return;
    const context = await readActiveExtensionContext(domainService);
    if (event.event === 'projectStatus.changed') {
        if (context.kind !== 'session' || context.sessionId !== event.payload.sessionId) return;
        await extensionService.projectStatusChanged(context);
        return;
    }
    if (event.event === 'git.changed') {
        if (context.kind !== 'session' || !event.payload.sessionIds.includes(context.sessionId))
            return;
        await extensionService.gitChanged(context);
        return;
    }
    if (
        event.payload.kind === 'full' &&
        ['session.select', 'session.create', 'session.delete', 'session.workbenchRoot'].includes(
            event.payload.reason,
        )
    )
        await extensionService.activeContextChanged(context);
}

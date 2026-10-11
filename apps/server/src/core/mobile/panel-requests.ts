import { randomUUID } from 'node:crypto';

import type { Principal, ServerRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import type { ExtensionService } from '../extensions/service';
import { toExtensionViewEventContext } from '../extensions/service-events';
import { mobilePanelViewKind, projectMobileIcon, projectMobileTreeItem } from './panel-projection';
import { sessionForPrincipal } from './session-management';

type PanelRequest = Extract<
    ServerRequest,
    { method: 'mobile.panels.list' | 'mobile.tree.children' }
>;

/**
 * Projects the Desktop's Extension panels onto a paired device. Both reads admit the Session first and re-check the
 * device generation through `reauthorize` after the Extension catalog or provider answers, so a revocation while the
 * provider runs never releases its result.
 */
export async function invokeMobilePanelRequest(
    request: PanelRequest,
    principal: Extract<Principal, { kind: 'paired-device' }>,
    domainService: ServerDomainService,
    extensionService: ExtensionService | undefined,
    reauthorize: () => void,
) {
    await sessionForPrincipal(domainService, principal, request.params.sessionId);
    if (request.method === 'mobile.panels.list') {
        if (!extensionService)
            throw new CaxriError('UNAVAILABLE', 'Extension catalog is unavailable');
        const catalog = extensionService.catalog();
        const panels = catalog.containers
            .filter((container) => container.location === 'secondarySidebar')
            .map((container) => ({
                id: container.id,
                title: container.title,
                ...(projectMobileIcon(container.icon) && {
                    icon: projectMobileIcon(container.icon),
                }),
                views: catalog.views
                    .filter((view) => view.containerId === container.id)
                    .map((view) => ({
                        id: view.id,
                        title: view.title,
                        kind: mobilePanelViewKind(view.viewKind),
                        ...(view.badge === true && { hasBadge: true }),
                    })),
            }));
        reauthorize();
        return { panels };
    }
    const activeContext = await domainService.request('app.activeContext', {});
    const notActive = () =>
        new CaxriError('CONFLICT', 'Conversation Tree only reflects the Desktop active Session');
    if (activeContext.sessionId !== request.params.sessionId) throw notActive();
    if (!extensionService) throw new CaxriError('UNAVAILABLE', 'Extension Host is unavailable');
    let result: Awaited<ReturnType<ExtensionService['treeChildren']>>;
    try {
        result = await extensionService.treeChildren({
            viewId: request.params.viewId,
            ...(request.params.parentHandle && { parentHandle: request.params.parentHandle }),
            requestId: randomUUID(),
            /**
             * Pins the read to the Session verified above, so a Desktop Session switch while the provider runs cancels
             * the request instead of answering with another Session's tree.
             */
            context: toExtensionViewEventContext(activeContext),
        });
    } catch (error) {
        // The phone shows its "open this Session on your computer" state only for CONFLICT, which is what a Desktop
        // Session switch during the read means.
        if (error instanceof CaxriError && error.code === 'CANCELLED') throw notActive();
        throw error;
    }
    reauthorize();
    return {
        items: result.items.map((item) => projectMobileTreeItem(item)),
        ...(result.reset && { reset: result.reset }),
    };
}

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
    { method: 'mobile.panels.list' | 'mobile.tree.children' | 'mobile.tree.executeCommand' }
>;

/**
 * Projects the Desktop's Extension panels onto a paired device and runs their tree rows' inline actions. Every request
 * admits the Session first and re-checks the device generation through `reauthorize` after the Extension catalog,
 * provider, or command answers, so a revocation while it runs never releases its result.
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
    if (!extensionService) throw new CaxriError('UNAVAILABLE', 'Extension Host is unavailable');
    if (request.method === 'mobile.tree.executeCommand') {
        const context = toExtensionViewEventContext(
            await domainService.request('app.sessionContext', {
                sessionId: request.params.sessionId,
            }),
        );
        if (context.kind !== 'session')
            throw new CaxriError('NOT_FOUND', 'Session is not available for this command');
        // Re-checked before the command starts, since it may merge a pull request a revoked device must not reach.
        reauthorize();
        const result = await extensionService.executeCommand(
            request.params.commandId,
            request.params.arguments,
            context,
        );
        reauthorize();
        return result;
    }
    /**
     * Scoped to the Session the phone is viewing, whichever Session Desktop has focused. The Extension service cancels
     * the read if that Session is deleted, hidden, or rebound to another Workbench Root while it runs.
     */
    const context = toExtensionViewEventContext(
        await domainService.request('app.sessionContext', { sessionId: request.params.sessionId }),
    );
    if (context.kind !== 'session')
        throw new CaxriError('NOT_FOUND', 'Session is not available for the Conversation Tree');
    const result = await extensionService.treeChildren({
        viewId: request.params.viewId,
        ...(request.params.parentHandle && { parentHandle: request.params.parentHandle }),
        requestId: randomUUID(),
        context,
    });
    reauthorize();
    const extensionCommands = new Set(
        extensionService
            .catalog()
            .commands.filter((command) => command.source.kind === 'extension')
            .map((command) => command.id),
    );
    return {
        items: result.items.map((item) =>
            projectMobileTreeItem(item, (commandId) => extensionCommands.has(commandId)),
        ),
        ...(result.reset && { reset: result.reset }),
    };
}

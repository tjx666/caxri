import type { ExtensionViewChange, ServerEvent, ViewDescriptor } from '@caxri/protocol';

import type { ControlServer } from '../control-server';
import type { ExtensionService } from './service';

export function isExtensionViewChangeCompatible(
    viewKind: ViewDescriptor['viewKind'],
    change: ExtensionViewChange,
): boolean {
    if (change.kind === 'badge') return true;
    if (viewKind.kind === 'source-control')
        return ['content', 'refresh', 'selection'].includes(change.kind);
    return false;
}

export function publishExtensionViewEvents(
    service: ExtensionService,
    server: () => ControlServer | undefined,
    /**
     * Receives the tree refresh a paired phone follows. Desktop windows get it through {@link ControlServer.broadcast};
     * the mobile gateway only sees events handed to it explicitly.
     */
    publishToMobile?: (event: ServerEvent) => void,
): void {
    service.onTreeChanged(({ viewId, eventId, extensionGeneration, context, handles }) => {
        const event = {
            event: 'viewContainers.treeChanged',
            payload: {
                viewId,
                eventId,
                extensionGeneration,
                context,
                ...(handles && { handles }),
            },
        } as const;
        server()?.broadcast(event);
        publishToMobile?.(event);
    });
    service.onViewChanged(({ viewId, change, eventId, extensionGeneration, context }) =>
        server()?.broadcast({
            event: 'viewContainers.viewChanged',
            payload: { viewId, eventId, extensionGeneration, context, change },
        }),
    );
}

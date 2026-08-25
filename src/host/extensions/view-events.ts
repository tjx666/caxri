import type { ExtensionViewChange, ViewDescriptor } from '@caxri/protocol';

import type { LocalHostServer } from '../local-server';
import type { ExtensionService } from './service';

export function isExtensionViewChangeCompatible(
    viewKind: ViewDescriptor['viewKind'],
    change: ExtensionViewChange,
): boolean {
    if (viewKind.kind === 'resource-explorer')
        return ['collapse', 'content', 'create', 'operation', 'refresh', 'search'].includes(
            change.kind,
        );
    if (viewKind.kind === 'source-control')
        return ['content', 'mode', 'refresh'].includes(change.kind);
    return false;
}

export function publishExtensionViewEvents(
    service: ExtensionService,
    server: () => LocalHostServer | undefined,
): void {
    service.onTreeChanged(({ viewId, eventId, extensionGeneration, context, handles }) =>
        server()?.broadcast({
            event: 'viewContainers.treeChanged',
            payload: {
                viewId,
                eventId,
                extensionGeneration,
                context,
                ...(handles && { handles }),
            },
        }),
    );
    service.onViewChanged(({ viewId, change, eventId, extensionGeneration, context }) =>
        server()?.broadcast({
            event: 'viewContainers.viewChanged',
            payload: { viewId, eventId, extensionGeneration, context, change },
        }),
    );
}

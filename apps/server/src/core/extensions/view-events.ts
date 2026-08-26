import type { ExtensionViewChange, ViewDescriptor } from '@caxri/protocol';

import type { ControlServer } from '../control-server';
import type { ExtensionService } from './service';

export function isExtensionViewChangeCompatible(
    viewKind: ViewDescriptor['viewKind'],
    change: ExtensionViewChange,
): boolean {
    if (viewKind.kind === 'source-control')
        return ['content', 'refresh', 'selection'].includes(change.kind);
    return false;
}

export function publishExtensionViewEvents(
    service: ExtensionService,
    server: () => ControlServer | undefined,
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

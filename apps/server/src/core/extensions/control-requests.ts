import type { ServerRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { readActiveExtensionContext } from './domain-events';
import type { ExtensionService } from './service';

const EXTENSION_CONTROL_METHODS = [
    'viewContainers.catalog',
    'viewContainers.treeChildren',
    'viewContainers.viewOperation',
    'viewContainers.executeCommand',
    'viewContainers.cancelRequest',
    'extensions.retry',
] as const;

type ExtensionControlRequest = Extract<
    ServerRequest,
    { method: (typeof EXTENSION_CONTROL_METHODS)[number] }
>;

export function isExtensionControlRequest(
    request: ServerRequest,
): request is ExtensionControlRequest {
    return (EXTENSION_CONTROL_METHODS as readonly string[]).includes(request.method);
}

/**
 * Serves the Extension view and command `control` methods from Server Core's {@link ExtensionService}. The service is
 * `undefined` until Extension Host startup completes, so each method states how it degrades without one.
 */
export async function invokeExtensionControlRequest(
    request: ExtensionControlRequest,
    extensionService: ExtensionService | undefined,
    domainService: Pick<ServerDomainService, 'request'>,
) {
    switch (request.method) {
        case 'viewContainers.catalog':
            if (!extensionService)
                throw new CaxriError('UNAVAILABLE', 'Extension catalog is unavailable');
            return extensionService.catalog();
        case 'viewContainers.treeChildren':
            if (!extensionService)
                throw new CaxriError('UNAVAILABLE', 'Extension Host is unavailable');
            return extensionService.treeChildren(request.params);
        case 'viewContainers.viewOperation':
            if (!extensionService)
                throw new CaxriError('UNAVAILABLE', 'Extension Host is unavailable');
            return extensionService.viewOperation(request.params);
        case 'viewContainers.executeCommand': {
            if (!extensionService)
                throw new CaxriError('UNAVAILABLE', 'Extension Host is unavailable');
            const context = await readActiveExtensionContext(domainService);
            if (context.kind !== 'session')
                throw new CaxriError('FORBIDDEN', 'Extension commands require an active Session');
            return extensionService.executeCommand(
                request.params.commandId,
                request.params.arguments,
                context,
            );
        }
        case 'viewContainers.cancelRequest':
            return extensionService?.cancel(request.params.requestId) ?? { cancelled: false };
        case 'extensions.retry':
            if (!extensionService)
                return {
                    accepted: false,
                    error: {
                        code: 'EXTENSION_HOST_UNAVAILABLE' as const,
                        message: 'Extension Host is unavailable',
                    },
                };
            return extensionService.retry(request.params.extensionId);
    }
}

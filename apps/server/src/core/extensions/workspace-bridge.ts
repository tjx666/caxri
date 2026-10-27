import type { ServerOperationParameters } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { ServerDomainService } from '../../core/domain-service';
import type { ExtensionWorkspaceOperation } from '../../extension-host/protocol';
import type { ServerDesktopRouter } from '../desktop-router';

interface ExtensionWorkspaceBridgeOptions {
    desktopRouter(): ServerDesktopRouter | undefined;
    domainService: Pick<ServerDomainService, 'requestInWorkbenchContext'>;
}

/**
 * Routes only the public Git Extension API allowlist. Domain services remain authoritative for repositories, while
 * native discard confirmation crosses the current Desktop generation through its bounded bridge.
 */
export function createExtensionWorkspaceRequest(options: ExtensionWorkspaceBridgeOptions) {
    return async (
        operation: ExtensionWorkspaceOperation,
        parameters: unknown,
        context: { sessionId: string; workbenchRootProjectId: string },
        signal?: AbortSignal,
    ): Promise<unknown> => {
        if (operation === 'git.discard') {
            const desktopRouter = options.desktopRouter();
            if (!desktopRouter)
                throw new CaxriError('UNAVAILABLE', 'Desktop routing is unavailable');
            return desktopRouter.discard(
                parameters as ServerOperationParameters<'git.discard'>,
                signal,
                context,
            );
        }
        return signal
            ? options.domainService.requestInWorkbenchContext(
                  operation,
                  parameters as never,
                  context,
                  undefined,
                  signal,
              )
            : options.domainService.requestInWorkbenchContext(
                  operation,
                  parameters as never,
                  context,
              );
    };
}

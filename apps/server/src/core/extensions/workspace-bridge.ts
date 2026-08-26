import type { RuntimeMethodParams as RuntimeMethodParameters } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { ServerDomainService } from '../../core/domain-service';
import type { ExtensionWorkspaceOperation } from '../../extension-host/protocol';
import type { HostDesktopRouter } from '../desktop-router';

interface ExtensionBootstrapContext {
    selectedSessionId?: string;
    sessions: Array<{
        id: string;
        projectId: string;
        workbenchProjectId: string;
    }>;
}

interface ExtensionWorkspaceBridgeOptions {
    desktopRouter(): HostDesktopRouter | undefined;
    runtime: Pick<ServerDomainService, 'requestInWorkbenchContext'>;
}

export function extensionActiveContext(bootstrap: ExtensionBootstrapContext): {
    ownerProjectId?: string;
    sessionId?: string;
    workbenchProjectId?: string;
} {
    const session = bootstrap.sessions.find(({ id }) => id === bootstrap.selectedSessionId);
    return session
        ? {
              ownerProjectId: session.projectId,
              sessionId: session.id,
              workbenchProjectId: session.workbenchProjectId,
          }
        : {};
}

/**
 * Routes only the public Git Extension API allowlist. Runtime remains authoritative for repositories, while native
 * discard confirmation crosses the current Desktop generation through its bounded bridge.
 */
export function createExtensionWorkspaceRequest(options: ExtensionWorkspaceBridgeOptions) {
    return async (
        operation: ExtensionWorkspaceOperation,
        parameters: unknown,
        context: { sessionId: string; workbenchProjectId: string },
        signal?: AbortSignal,
    ): Promise<unknown> => {
        if (operation === 'git.discard') {
            const desktopRouter = options.desktopRouter();
            if (!desktopRouter)
                throw new CaxriError('UNAVAILABLE', 'Desktop routing is unavailable');
            return desktopRouter.discard(
                parameters as RuntimeMethodParameters<'git.discard'>,
                signal,
                context,
            );
        }
        return signal
            ? options.runtime.requestInWorkbenchContext(
                  operation,
                  parameters as never,
                  context,
                  undefined,
                  signal,
              )
            : options.runtime.requestInWorkbenchContext(operation, parameters as never, context);
    };
}

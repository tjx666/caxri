import type { ExtensionWorkspaceOperation } from '../../shared/extension-host-protocol';
import { CaxriError } from '../../shared/ipc/errors';
import type { RuntimeMethodParams as RuntimeMethodParameters } from '../../shared/ipc/methods';
import type { HostDesktopRouter } from '../desktop-router';
import type { HostRuntimeSupervisor } from '../runtime-supervisor';

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
    runtime: Pick<HostRuntimeSupervisor, 'requestInWorkbenchContext'>;
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
 * Routes only the public Extension API workspace allowlist. Runtime remains authoritative for paths and repositories;
 * native confirmation and reveal operations cross the current Desktop generation through its bounded bridge.
 */
export function createExtensionWorkspaceRequest(options: ExtensionWorkspaceBridgeOptions) {
    return async (
        operation: ExtensionWorkspaceOperation,
        parameters: unknown,
        context: { sessionId: string; workbenchProjectId: string },
        signal?: AbortSignal,
    ): Promise<unknown> => {
        const desktopRouter = options.desktopRouter();
        if (operation === 'files.reveal') {
            if (!desktopRouter)
                throw new CaxriError('UNAVAILABLE', 'Desktop routing is unavailable');
            const { path, sessionId } = parameters as { path: string; sessionId: string };
            await desktopRouter.open(
                'reveal',
                undefined,
                {
                    launchIfNeeded: false,
                    path,
                    sessionId,
                },
                signal,
                context,
            );
            return null;
        }
        if (operation === 'files.trash') {
            if (!desktopRouter)
                throw new CaxriError('UNAVAILABLE', 'Desktop routing is unavailable');
            return desktopRouter.trash(
                parameters as RuntimeMethodParameters<'files.trash'>,
                signal,
                context,
            );
        }
        if (operation === 'git.discard') {
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

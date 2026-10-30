import type { CaxriRequest, CommandAdapter, EventRecovery, MainRequest } from '@caxri/protocol';
import { CaxriError, isMainRequest } from '@caxri/protocol';

import type { DesktopServerConnection } from './connection/server-connection';
import { createElectronIpcCommandAdapter } from './ipc-command-adapter';
import { forwardAsRequestWindow } from './window-presence-registry';

interface WorkbenchCommandAdapterOptions {
    connection: () => DesktopServerConnection;
    eventRelay: { recover(afterCursor: number): Promise<EventRecovery> };
    handleMainMethod: (request: MainRequest) => Promise<unknown>;
    isWindowAvailable: () => boolean;
    /**
     * Resolves once Server Core is attached; every Renderer request waits on it instead of failing `UNAVAILABLE`.
     */
    serverReady: Promise<void>;
    /**
     * Raises the window that owns a Session another window asked for. The Server already activated the Session there
     * and left the requester unchanged; Main only has to bring the owner forward.
     */
    raiseOwnerWindow: (ownerWindowKey: string, method: string) => void;
}

/**
 * The owner a redirected `session.select` or `session.resume` names, else `undefined`.
 */
function redirectedOwner(method: string, result: unknown): string | undefined {
    if (method !== 'session.select' && method !== 'session.resume') return undefined;
    if (typeof result !== 'object' || result === null || !('ownerWindowKey' in result))
        return undefined;
    return typeof result.ownerWindowKey === 'string' ? result.ownerWindowKey : undefined;
}

/**
 * The local Workbench's command transport: Server methods are forwarded to the local connection (acting as the window
 * that sent them when they are window-scoped), and Main-owned methods run in Main.
 */
export function createWorkbenchCommandAdapter(options: WorkbenchCommandAdapterOptions) {
    const { connection, eventRelay, handleMainMethod, isWindowAvailable, serverReady } = options;
    return createElectronIpcCommandAdapter({
        server: {
            invoke: async (request, _context, invocation) => {
                await serverReady;
                if (request.method === 'events.recover')
                    return eventRelay.recover(request.params.afterCursor);
                const result = await forwardAsRequestWindow(
                    connection(),
                    request.method,
                    request.params,
                    invocation.requestId,
                );
                const owner = redirectedOwner(request.method, result);
                if (owner) options.raiseOwnerWindow(owner, request.method);
                return result;
            },
        },
        desktop: {
            isAvailable: isWindowAvailable,
            invoke: (async (request: CaxriRequest) => {
                if (!isMainRequest(request))
                    throw new CaxriError('INTERNAL', 'Server command reached the Desktop adapter');
                await serverReady;
                return handleMainMethod(request);
            }) satisfies CommandAdapter['invoke'],
        },
    });
}

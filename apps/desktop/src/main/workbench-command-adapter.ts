import type { CaxriRequest, CommandAdapter, EventRecovery, MainRequest } from '@caxri/protocol';
import { CaxriError, isMainRequest } from '@caxri/protocol';

import { createElectronIpcCommandAdapter } from './ipc-command-adapter';
import type { DesktopServerConnection } from './server-connection';
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
                return request.method === 'events.recover'
                    ? eventRelay.recover(request.params.afterCursor)
                    : forwardAsRequestWindow(
                          connection(),
                          request.method,
                          request.params,
                          invocation.requestId,
                      );
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

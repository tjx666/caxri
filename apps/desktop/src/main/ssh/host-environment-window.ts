import type { CaxriRequest, CommandAdapter, MainRequest, ServerEvent } from '@caxri/protocol';
import { CaxriError, isMainRequest } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { BrowserWindowConstructorOptions } from 'electron';
import { app, BrowserWindow, dialog } from 'electron';

import { DesktopServerConnection } from '../connection/server-connection';
import type { SharedServerConnectionOptions } from '../connection/server-connection-options';
import { createDesktopActions } from '../desktop-actions';
import { createDesktopOperationHandler } from '../desktop-operations';
import { guardEnvironmentMethods } from '../environment-method-policy';
import { createMainEventRelay } from '../event-relay';
import { createElectronIpcCommandAdapter } from '../ipc-command-adapter';
import { createWorkbenchUnsavedEditors } from '../unsaved-editors';
import { defaultWindowState } from '../window-placement';
import type { WindowPresenceRegistry } from '../window-presence-registry';
import {
    createConnectionPresence,
    forwardAsRequestWindow,
    PRIMARY_WINDOW_KEY,
} from '../window-presence-registry';
import { installRendererGuards } from '../workbench-renderer-guards';
import type {
    SshHostEnvironmentHooks,
    SshHostEnvironmentParts,
    SshHostSupervisor,
} from './host-environments';

interface SshHostMainHandlerInput {
    connection: DesktopServerConnection;
    focusWindow: () => Promise<void>;
    onUnsavedEditorsReply: ReturnType<typeof createWorkbenchUnsavedEditors>['reply'];
    sendEvent: (event: ServerEvent) => void;
    window: () => BrowserWindow | undefined;
    windowPresence: WindowPresenceRegistry;
}

export interface SshHostEnvironmentWindowOptions {
    /**
     * Window chrome and `webPreferences` shared with the local Workbench window.
     */
    chrome(): BrowserWindowConstructorOptions;
    /**
     * The local connection's options without its supervisor seams; an SSH Host connection reuses its build identity and
     * local artifact (for the build fingerprint) and replaces discovery and supervision.
     */
    connection: SharedServerConnectionOptions;
    createMainHandler(input: SshHostMainHandlerInput): (request: MainRequest) => Promise<unknown>;
    createSupervisor(destination: string, hooks: SshHostEnvironmentHooks): SshHostSupervisor;
    isQuitting(): boolean;
    loadRenderer(window: BrowserWindow): void;
    logger: () => StructuredLogger;
    /**
     * Resolves once this environment's Server is attached; Renderer Server requests wait on it.
     */
    whenAttached(window: BrowserWindow): Promise<void>;
}

/**
 * Builds the window, Server connection, event relay, and IPC transport for one SSH Host. Everything the local Workbench
 * window has is rebuilt per environment so no request, event, or native prompt can cross to the wrong Server.
 */
export function createSshHostEnvironmentParts(options: SshHostEnvironmentWindowOptions) {
    return (destination: string, hooks: SshHostEnvironmentHooks): SshHostEnvironmentParts => {
        const window = new BrowserWindow({
            ...defaultWindowState.bounds,
            minWidth: 960,
            minHeight: 640,
            ...options.chrome(),
            title: `SSH: ${destination}`,
            show: false,
        });
        const liveWindow = (): BrowserWindow | undefined =>
            window.isDestroyed() ? undefined : window;
        const focusWindow = (): Promise<void> => {
            if (!window.isDestroyed()) {
                if (window.isMinimized()) window.restore();
                window.show();
                window.focus();
            }
            return Promise.resolve();
        };
        /**
         * The relay and the connection reference each other: the relay reloads state through the connection and the
         * connection delivers events through the relay. The relay only reloads after the Renderer asks, by which time
         * the connection exists.
         */
        const bootstrap: { connection?: DesktopServerConnection } = {};
        const relay = createMainEventRelay({
            deliver: (message) => liveWindow()?.webContents.send('caxri:event', message),
            loadState: () => {
                if (!bootstrap.connection)
                    throw new CaxriError('UNAVAILABLE', 'The SSH Host connection is not ready');
                return bootstrap.connection.request('app.bootstrap');
            },
            logger: options.logger,
            // The native menu follows the local Workbench's keybindings and language.
            onMenuRefreshRequested: () => {},
        });
        const sendEvent = (event: ServerEvent): void => relay.send(event);
        const supervisor = options.createSupervisor(destination, hooks);
        const desktopOperations = createDesktopOperationHandler(
            createDesktopActions({
                environment: 'ssh',
                focusMainWindow: async () => {
                    await focusWindow();
                    return window;
                },
                getMainWindow: liveWindow,
                sendEvent,
            }),
        );
        /**
         * This window's presence on its own Server. The connection exists after the registry, so the registry reaches
         * it through `bootstrap`, the same indirection the relay uses.
         */
        const presence = createConnectionPresence(() => bootstrap.connection!, options.logger);
        presence.register(PRIMARY_WINDOW_KEY, window.webContents, window);
        const connection = new DesktopServerConnection({
            ...options.connection,
            seedAttachment: (send) => presence.seed(send),
            systemLanguages: () => [app.getLocale()],
            createServerSupervisor: () => supervisor,
            discoverDesktop: () => supervisor.discoverDesktop(),
            handleCommand: desktopOperations,
            logger: options.logger(),
        });
        bootstrap.connection = connection;
        /**
         * The connection overlay explains a lease another Desktop replaced (`takenOver`) and offers to take it back, so
         * the local window's "continue in the other window" notice, which the relay would also replay, is not sent.
         */
        connection.onEvent((event) => {
            if (event.event === 'host.connectionChanged' && event.payload.status === 'replaced')
                return;
            sendEvent(event);
        });
        const unsavedEditors = createWorkbenchUnsavedEditors({
            dialog,
            windows: () => {
                const window = liveWindow();
                return window ? [{ key: PRIMARY_WINDOW_KEY, window }] : [];
            },
            logger: options.logger,
            sendEvent: (event) => sendEvent(event),
        });
        const handleMainMethod = guardEnvironmentMethods(
            'ssh',
            options.createMainHandler({
                connection,
                focusWindow,
                onUnsavedEditorsReply: (parameters) => unsavedEditors.reply(parameters),
                sendEvent,
                window: liveWindow,
                windowPresence: presence,
            }),
        );
        const transport = createElectronIpcCommandAdapter({
            server: {
                invoke: async (request, _context, invocation) => {
                    await options.whenAttached(window);
                    return request.method === 'events.recover'
                        ? relay.recover(request.params.afterCursor)
                        : forwardAsRequestWindow(
                              connection,
                              request.method,
                              request.params,
                              invocation.requestId,
                          );
                },
            },
            desktop: {
                isAvailable: () => !window.isDestroyed(),
                invoke: (async (request: CaxriRequest) => {
                    if (!isMainRequest(request))
                        throw new CaxriError(
                            'INTERNAL',
                            'Server command reached the Desktop adapter',
                        );
                    return handleMainMethod(request);
                }) satisfies CommandAdapter['invoke'],
            },
        });

        relay.rendererPending(PRIMARY_WINDOW_KEY);
        window.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
            if (isMainFrame) relay.rendererPending(PRIMARY_WINDOW_KEY);
        });
        window.once('ready-to-show', () => window.show());
        installRendererGuards(window, { logger: options.logger, window: 'ssh-host' });
        let isForceClose = false;
        window.on('close', (event) => {
            if (isForceClose || options.isQuitting()) return;
            event.preventDefault();
            /**
             * Closing only detaches: the SSH Host keeps its Terminals and Agents. Unsaved Editor buffers are the one
             * thing that would be lost, so they get the same decision as the local window.
             */
            void unsavedEditors
                .decide('close')
                .catch(() => 'continue' as const)
                .then((decision) => {
                    if (decision === 'cancel' || window.isDestroyed()) return;
                    isForceClose = true;
                    window.close();
                });
        });
        options.loadRenderer(window);

        return {
            connection,
            route: {
                isRecovering: () => connection.isRecovering(),
                onEventsReady: () => {
                    relay.rendererReady(PRIMARY_WINDOW_KEY);
                    void options
                        .whenAttached(window)
                        .then(() => connection.markDesktopReady())
                        .catch(() => {});
                },
                transport,
                windowKey: PRIMARY_WINDOW_KEY,
            },
            sendEvent,
            supervisor,
            window,
        };
    };
}

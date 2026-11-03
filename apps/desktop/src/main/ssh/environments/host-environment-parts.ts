import type { CaxriRequest, CommandAdapter, MainRequest, ServerEvent } from '@caxri/protocol';
import { CaxriError, isMainRequest } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { BrowserWindow } from 'electron';
import { app, dialog } from 'electron';

import { sshHostServerUpdatePrompt } from '../../confirmations';
import { DesktopServerConnection } from '../../connection/server-connection';
import type { SharedServerConnectionOptions } from '../../connection/server-connection-options';
import { createDesktopActions } from '../../desktop-actions';
import { createDesktopOperationHandler } from '../../desktop-operations';
import { guardEnvironmentMethods } from '../../environment-method-policy';
import { createMainEventRelay } from '../../event-relay';
import { createElectronIpcCommandAdapter } from '../../ipc-command-adapter';
import type { WindowPresenceRegistry } from '../../window-presence-registry';
import {
    createConnectionPresence,
    forwardAsRequestWindow,
    PRIMARY_WINDOW_KEY,
} from '../../window-presence-registry';
import type {
    SshHostEnvironmentHooks,
    SshHostEnvironmentParts,
    SshHostSupervisor,
} from './host-environments';

interface SshHostMainHandlerInput {
    connection: DesktopServerConnection;
    environmentId: string;
    focusWindow: () => Promise<void>;
    sendEvent: (event: ServerEvent) => void;
    window: () => BrowserWindow | undefined;
    windowPresence: WindowPresenceRegistry;
}

export interface SshHostEnvironmentPartsOptions {
    /**
     * The local connection's options without its supervisor seams; an SSH Host connection reuses its build identity and
     * local artifact (for the build fingerprint) and replaces discovery and supervision.
     */
    connection: SharedServerConnectionOptions;
    createMainHandler(input: SshHostMainHandlerInput): (request: MainRequest) => Promise<unknown>;
    createSupervisor(destination: string, hooks: SshHostEnvironmentHooks): SshHostSupervisor;
    /**
     * Sends one event message of `environmentId` to the Workbench window's Renderer.
     */
    deliver(environmentId: string, message: unknown): void;
    logger: () => StructuredLogger;
    /**
     * Calls `listener` with the primary Workbench window now (when one exists) and each time a new one opens, until the
     * returned function is called.
     */
    observeWorkbenchWindow: (listener: (window: BrowserWindow) => void) => () => void;
    /**
     * Resolves once this environment's Server is attached; Renderer Server requests wait on it.
     */
    whenAttached(environmentId: string): Promise<void>;
    /**
     * The primary Workbench window, which shows every SSH Host's Projects beside this Mac's.
     */
    workbenchWindow: () => BrowserWindow | undefined;
}

/**
 * Builds the Server connection, event relay, and IPC transport for one SSH Host. The Host has no window of its own: the
 * primary Workbench window reaches it by naming its `environmentId`, and everything request-scoped (presence, Main
 * method handler, desktop operations) is still rebuilt per environment so no request, event, or native prompt can cross
 * to the wrong Server.
 */
export function createSshHostEnvironmentParts(options: SshHostEnvironmentPartsOptions) {
    return (
        destination: string,
        environmentId: string,
        hooks: SshHostEnvironmentHooks,
    ): SshHostEnvironmentParts => {
        const liveWindow = (): BrowserWindow | undefined => {
            const window = options.workbenchWindow();
            return window && !window.isDestroyed() ? window : undefined;
        };
        const focusWorkbench = (): void => {
            const window = liveWindow();
            if (!window) return;
            if (window.isMinimized()) window.restore();
            window.show();
            window.focus();
        };
        /**
         * The relay and the connection reference each other: the relay reloads state through the connection and the
         * connection delivers events through the relay. The relay only reloads after the Renderer asks, by which time
         * the connection exists.
         */
        const bootstrap: { connection?: DesktopServerConnection } = {};
        const relay = createMainEventRelay({
            deliver: (message) => options.deliver(environmentId, message),
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
                focusMainWindow: () => {
                    focusWorkbench();
                    const window = liveWindow();
                    return window
                        ? Promise.resolve(window)
                        : Promise.reject(
                              new CaxriError('UNAVAILABLE', 'The Workbench window is closed'),
                          );
                },
                getMainWindow: liveWindow,
                sendEvent,
            }),
        );
        /**
         * The Workbench window's presence on this SSH Host's Server. The connection exists after the registry, so the
         * registry reaches it through `bootstrap`, the same indirection the relay uses. The window reports a viewed
         * Session only to the Server that owns it, so this Server sees it as visible with nothing viewed otherwise and
         * keeps its Terminals and watchers running.
         */
        const presence = createConnectionPresence(() => bootstrap.connection!, options.logger);
        const stopObservingWindow = options.observeWorkbenchWindow((window) => {
            presence.register(PRIMARY_WINDOW_KEY, window.webContents, window);
            relay.rendererPending(PRIMARY_WINDOW_KEY);
            window.webContents.on(
                'did-start-navigation',
                (_event, _url, _isInPlace, isMainFrame) => {
                    if (isMainFrame) relay.rendererPending(PRIMARY_WINDOW_KEY);
                },
            );
        });
        const connection = new DesktopServerConnection({
            ...options.connection,
            seedAttachment: (send) => presence.seed(send),
            systemLanguages: () => [app.getLocale()],
            createServerSupervisor: () => supervisor,
            /**
             * Nothing else warns before this SSH Host's Server is replaced by this Desktop's build, so ask while it
             * still runs work. Not Now keeps that work running and ends the attach on a terminal `updateDeferred`
             * failure.
             */
            confirmStaleReplacement: async (running) => {
                focusWorkbench();
                const prompt = sshHostServerUpdatePrompt(destination, running);
                const window = liveWindow();
                const { response } = window
                    ? await dialog.showMessageBox(window, prompt)
                    : { response: prompt.cancelId };
                if (response === 0) return true;
                supervisor.deferUpdate();
                return false;
            },
            discoverDesktop: () => supervisor.discoverDesktop(),
            handleCommand: desktopOperations,
            logger: options.logger(),
        });
        bootstrap.connection = connection;
        /**
         * The connection card explains a lease another Desktop replaced (`takenOver`) and offers to take it back, so
         * the local Server's "continue in the other window" notice, which the relay would also replay, is not sent.
         */
        connection.onEvent((event) => {
            if (event.event === 'host.connectionChanged' && event.payload.status === 'replaced')
                return;
            sendEvent(event);
        });
        const handleMainMethod = guardEnvironmentMethods(
            'ssh',
            options.createMainHandler({
                connection,
                environmentId,
                focusWindow: () => {
                    focusWorkbench();
                    return Promise.resolve();
                },
                sendEvent,
                window: liveWindow,
                windowPresence: presence,
            }),
        );
        const transport = createElectronIpcCommandAdapter({
            server: {
                invoke: async (request, _context, invocation) => {
                    await options.whenAttached(environmentId);
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
                isAvailable: () => liveWindow() !== undefined,
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

        return {
            connection,
            focusWorkbench,
            route: {
                isRecovering: () => connection.isRecovering(),
                onEventsReady: () => {
                    relay.rendererReady(PRIMARY_WINDOW_KEY);
                    void options
                        .whenAttached(environmentId)
                        .then(() => connection.markDesktopReady())
                        .catch(() => {});
                },
                transport,
                windowKey: PRIMARY_WINDOW_KEY,
                window: liveWindow,
            },
            sendEvent,
            supervisor,
            unbind: stopObservingWindow,
        };
    };
}

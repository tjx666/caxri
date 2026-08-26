import type { CaxriReply } from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    isRendererErrorKind,
    RENDERER_ERROR_CHANNELS,
    requestIdFromEnvelope,
    toWireError,
} from '@caxri/protocol';
import type { WebContents } from 'electron';
import { ipcMain } from 'electron';

import type { StructuredLogger } from '../../../../src/shared/node/logger';
import { logEventCatalog } from '../../../../src/shared/node/logger';
import type { createElectronIpcCommandAdapter } from './ipc-command-adapter';

export interface WorkbenchIpcOptions {
    isQuitting(): boolean;
    logger(): StructuredLogger | undefined;
    onEventsReady?(): void;
    renderer(): WebContents | undefined;
    transport: ReturnType<typeof createElectronIpcCommandAdapter>;
}

/**
 * Installs the authenticated Electron transport without leaking Electron into the protocol.
 */
export function installWorkbenchIpc(options: WorkbenchIpcOptions): void {
    function assertSender(sender: WebContents): void {
        if (!options.renderer() || sender !== options.renderer())
            throw new CaxriError('PATH_DENIED', 'Untrusted IPC sender');
    }

    ipcMain.on(RENDERER_ERROR_CHANNELS.workbench, (event, rawKind: unknown) => {
        if (event.sender !== options.renderer() || !isRendererErrorKind(rawKind)) return;
        options
            .logger()
            ?.write(
                'error',
                rawKind === 'page-exception'
                    ? logEventCatalog.renderer.pageException
                    : logEventCatalog.renderer.unhandledRejection,
                {
                    fields: {
                        code:
                            rawKind === 'page-exception' ? 'PAGE_EXCEPTION' : 'UNHANDLED_REJECTION',
                    },
                },
            );
    });
    ipcMain.on('caxri:renderer-events-ready', (event) => {
        assertSender(event.sender);
        options.onEventsReady?.();
    });
    ipcMain.handle('caxri:request', async (event, raw: unknown): Promise<CaxriReply> => {
        let isTrustedRenderer = false;
        try {
            assertSender(event.sender);
            isTrustedRenderer = true;
            /**
             * Refuse queued Renderer work; explicit quit owns final Runtime I/O and shutdown.
             */
            if (options.isQuitting())
                return {
                    protocolVersion: CAXRI_PROTOCOL_VERSION,
                    id: requestIdFromEnvelope(raw),
                    ok: false,
                    error: toWireError(new CaxriError('UNAVAILABLE', 'Application is quitting')),
                };
            const reply = await options.transport.dispatch(raw);
            /**
             * In-flight reads can outlive the window once quit closes the Host; the consumer is already gone.
             */
            if (!reply.ok && reply.error.code !== 'CANCELLED' && !options.isQuitting())
                options.logger()?.write('error', logEventCatalog.ipc.requestFailed, {
                    fields: { code: reply.error.code, error: reply.error.message },
                });
            return reply;
        } catch (error) {
            /**
             * Replying with a classified envelope keeps the code intact across the preload.
             */
            const wire = toWireError(error);
            if (wire.code !== 'CANCELLED' && (!isTrustedRenderer || !options.isQuitting()))
                options.logger()?.write('error', logEventCatalog.ipc.requestFailed, {
                    fields: { code: wire.code, error: wire.message },
                });
            return {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id: requestIdFromEnvelope(raw),
                ok: false,
                error: wire,
            };
        }
    });
    ipcMain.handle('caxri:negotiate', (event, hello: unknown) => {
        assertSender(event.sender);
        return options.transport.negotiate(hello);
    });
}

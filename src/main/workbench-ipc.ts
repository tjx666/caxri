import { ipcMain, type WebContents } from 'electron';

import { requestIdFromEnvelope } from '../shared/ipc/dispatcher';
import { CaxriError, toWireError } from '../shared/ipc/errors';
import type { CaxriReply } from '../shared/ipc/transport';
import { CAXRI_PROTOCOL_VERSION } from '../shared/ipc/version';
import type { StructuredLogger } from '../shared/node/logger';
import { isRendererErrorKind, RENDERER_ERROR_CHANNELS } from '../shared/renderer-error';
import type { createElectronIpcCommandAdapter } from './ipc-command-adapter';

export interface WorkbenchIpcOptions {
    isQuitting(): boolean;
    logger(): StructuredLogger | undefined;
    onEventsReady?(): void;
    renderer(): WebContents | undefined;
    transport: ReturnType<typeof createElectronIpcCommandAdapter>;
}

/** Installs the authenticated Electron transport without leaking Electron into the protocol. */
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
                    ? 'renderer.page_exception'
                    : 'renderer.unhandled_rejection',
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
        try {
            assertSender(event.sender);
            /** Refuse queued Renderer work; explicit quit owns final Runtime I/O and shutdown. */
            if (options.isQuitting())
                return {
                    protocolVersion: CAXRI_PROTOCOL_VERSION,
                    id: requestIdFromEnvelope(raw),
                    ok: false,
                    error: toWireError(new CaxriError('UNAVAILABLE', 'Application is quitting')),
                };
            const reply = await options.transport.dispatch(raw);
            if (!reply.ok)
                options.logger()?.write('error', 'ipc.request_failed', {
                    fields: { code: reply.error.code, error: reply.error.message },
                });
            return reply;
        } catch (error) {
            /** Replying with a classified envelope keeps the code intact across the preload. */
            const wire = toWireError(error);
            options.logger()?.write('error', 'ipc.request_failed', {
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

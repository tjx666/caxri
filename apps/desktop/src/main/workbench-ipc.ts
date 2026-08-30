import type { CaxriReply, TerminalRendererDiagnostic } from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    isRendererErrorKind,
    RENDERER_DIAGNOSTIC_CHANNEL,
    RENDERER_ERROR_CHANNELS,
    rendererDiagnosticSchema,
    requestIdFromEnvelope,
    toWireError,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { WebContents } from 'electron';
import { ipcMain } from 'electron';

import type { createElectronIpcCommandAdapter } from './ipc-command-adapter';

export interface WorkbenchIpcOptions {
    isQuitting(): boolean;
    logger(): StructuredLogger | undefined;
    onRendererDiagnostic?(diagnostic: TerminalRendererDiagnostic): void;
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
    ipcMain.on(RENDERER_DIAGNOSTIC_CHANNEL, (event, rawDiagnostic: unknown) => {
        if (event.sender !== options.renderer()) return;
        const parsed = rendererDiagnosticSchema.safeParse(rawDiagnostic);
        if (!parsed.success) return;
        const diagnostic = parsed.data;
        if (diagnostic.kind === 'terminal-renderer') {
            options.onRendererDiagnostic?.(diagnostic);
            return;
        }
        options.logger()?.write('info', logEventCatalog.renderer.terminalResizeBurst, {
            fields: {
                code: 'TERMINAL_RESIZE_BURST',
                diagnosticId: diagnostic.diagnosticId,
                terminalId: diagnostic.terminalId,
                side: diagnostic.side,
                sampleCount: diagnostic.sampleCount,
                changeCount: diagnostic.changeCount,
                startCols: diagnostic.startCols,
                startRows: diagnostic.startRows,
                minCols: diagnostic.minCols,
                minRows: diagnostic.minRows,
                maxCols: diagnostic.maxCols,
                maxRows: diagnostic.maxRows,
                finalCols: diagnostic.finalCols,
                finalRows: diagnostic.finalRows,
                durationMs: diagnostic.durationMs,
                flushReason: diagnostic.flushReason,
                truncated: diagnostic.truncated,
                localAppliedCount: diagnostic.localAppliedCount,
                requestCount: diagnostic.requestCount,
            },
        });
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
             * Refuse queued Renderer work; explicit quit owns final Server I/O and shutdown.
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
             * In-flight reads can outlive the window once quit closes the Server attachment; the consumer is gone.
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

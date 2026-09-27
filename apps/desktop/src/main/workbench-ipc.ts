import type { CaxriReply, TerminalRendererDiagnostic } from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    isCallerHandledFailure,
    isRendererErrorKind,
    methodFromEnvelope,
    RENDERER_DIAGNOSTIC_CHANNEL,
    RENDERER_ERROR_CHANNELS,
    rendererDiagnosticSchema,
    requestIdFromEnvelope,
    toWireError,
} from '@caxri/protocol';
import type { EventLoopStallSummary, StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { WebContents } from 'electron';
import { ipcMain } from 'electron';

import type { createElectronIpcCommandAdapter } from './ipc-command-adapter';

/**
 * Failure codes that typically originate from ordinary Renderer-side user input (e.g. an unresolved path while the user
 * is still typing in the path browser) rather than a Caxri defect. These still need to be logged for diagnosability,
 * but at `warn` instead of `error` so expected input mistakes stop paging as production error beacons.
 */
const CALLER_SIDE_WARN_CODES = new Set<string>(['NOT_FOUND', 'VALIDATION']);

/**
 * Log level for one failed Renderer request. `UNAVAILABLE` is the code the connection answers with while it is between
 * attachments, so during recovery it describes an expected, self-healing window rather than a defect: waking the
 * machine drops the socket for a few hundred milliseconds and every request in flight fails until the reconnect loop
 * finishes. Outside recovery the same code is a genuine outage (a stopped Agent, an expired Workbench authority) and
 * keeps `error`.
 */
function requestFailureLevel(code: string, isRecovering: boolean): 'error' | 'warn' {
    if (CALLER_SIDE_WARN_CODES.has(code) || isCallerHandledFailure(code)) return 'warn';
    return code === 'UNAVAILABLE' && isRecovering ? 'warn' : 'error';
}

export interface WorkbenchIpcOptions {
    /**
     * Whether the Desktop↔Server connection is currently between attachments with recovery still owned by the reconnect
     * loop; see `DesktopServerConnection.isRecovering`.
     */
    isRecovering(): boolean;
    isQuitting(): boolean;
    logger(): StructuredLogger | undefined;
    onRendererDiagnostic?(diagnostic: TerminalRendererDiagnostic): void;
    /**
     * Main's own event-loop gaps, stamped onto the Renderer diagnostics whose cause may sit outside the Renderer. The
     * Renderer cannot measure this itself, and a reader joining two logs by timestamp gets no answer when the record
     * that matters was rate limited or rotated away.
     */
    readEventLoopStalls?(): EventLoopStallSummary | undefined;
    onEventsReady?(): void;
    renderer(): WebContents | undefined;
    /**
     * Optional second Renderer (the Agent Commander window) that shares the Workbench preload and Main's single
     * Desktop↔Server connection. It is trusted only for the requests its policy admits; diagnostics and Workbench
     * readiness stay bound to the main window.
     */
    companion?: CompanionRendererPolicy;
    transport: ReturnType<typeof createElectronIpcCommandAdapter>;
}

export interface CompanionRendererPolicy {
    renderer(): WebContents | undefined;
    /**
     * Throws a classified `CaxriError` when the companion may not send this request envelope.
     */
    admit(raw: unknown): void;
    /**
     * Observes a successful reply so the policy can learn identities it later admits (for example its Terminal).
     */
    observeReply?(raw: unknown, reply: CaxriReply): void;
    onEventsReady(): void;
    onRendererError(kind: 'page-exception' | 'unhandled-rejection'): void;
}

/**
 * Installs the authenticated Electron transport without leaking Electron into the protocol.
 */
export function installWorkbenchIpc(options: WorkbenchIpcOptions): void {
    function senderRole(sender: WebContents): 'companion' | 'workbench' | undefined {
        if (options.renderer() && sender === options.renderer()) return 'workbench';
        const companion = options.companion?.renderer();
        if (companion && sender === companion) return 'companion';
        return undefined;
    }

    function assertSender(sender: WebContents): 'companion' | 'workbench' {
        const role = senderRole(sender);
        if (!role) throw new CaxriError('PATH_DENIED', 'Untrusted IPC sender');
        return role;
    }

    ipcMain.on(RENDERER_ERROR_CHANNELS.workbench, (event, rawKind: unknown) => {
        if (!isRendererErrorKind(rawKind)) return;
        if (senderRole(event.sender) === 'companion') {
            options.companion?.onRendererError(rawKind);
            return;
        }
        if (event.sender !== options.renderer()) return;
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
        if (diagnostic.kind === 'gpu-incident-budget') {
            options
                .logger()
                ?.write(
                    diagnostic.transition === 'pinned' ? 'warn' : 'info',
                    logEventCatalog.gpu.sessionBudget,
                    {
                        correlationId: diagnostic.correlationId,
                        fields: {
                            code: 'GPU_SESSION_BUDGET',
                            diagnosticId: diagnostic.diagnosticId,
                            transition: diagnostic.transition,
                            cause: diagnostic.cause,
                            incidentCount: diagnostic.incidentCount,
                            contextLossEpisodeCount: diagnostic.contextLossEpisodeCount,
                            threshold: diagnostic.threshold,
                            preference: diagnostic.preference,
                        },
                    },
                );
            return;
        }
        if (diagnostic.kind === 'editor-worker-stall') {
            const mainLoop = options.readEventLoopStalls?.();
            options
                .logger()
                ?.write(
                    diagnostic.outcome === 'timeout' ? 'warn' : 'info',
                    logEventCatalog.renderer.editorWorkerStall,
                    {
                        fields: {
                            code: 'EDITOR_WORKER_STALL',
                            diagnosticId: diagnostic.diagnosticId,
                            surface: diagnostic.surface,
                            outcome: diagnostic.outcome,
                            waitMs: diagnostic.waitMs,
                            workerRoundTrip: diagnostic.workerRoundTrip,
                            workerRoundTripMs: diagnostic.workerRoundTripMs,
                            workerBroadcast: diagnostic.workerBroadcast,
                            documentVisible: diagnostic.documentVisible,
                            navigationType: diagnostic.navigationType,
                            pageAgeMs: diagnostic.pageAgeMs,
                            originalLineCount: diagnostic.originalLineCount,
                            modifiedLineCount: diagnostic.modifiedLineCount,
                            identicalModels: diagnostic.identicalModels,
                            diffOpenCount: diagnostic.diffOpenCount,
                            stallCount: diagnostic.stallCount,
                            editorWorkersCreated: diagnostic.editorWorkersCreated,
                            editorWorkersStarted: diagnostic.editorWorkersStarted,
                            editorWorkersStartupStalled: diagnostic.editorWorkersStartupStalled,
                            editorWorkersStartupStalledNow:
                                diagnostic.editorWorkersStartupStalledNow,
                            // Main-side context, not Renderer-reported: Worker creation, its `file://` script load out
                            // of `app.asar`, and `BroadcastChannel` brokering all run through this process, so a
                            // blocked Main loop is the leading explanation for a Worker that exists and never runs.
                            mainEventLoopBlockCount: mainLoop?.blockCount ?? null,
                            mainEventLoopLongestBlockMs: mainLoop?.longestBlockMs ?? null,
                            mainEventLoopMsSinceLastBlock: mainLoop?.msSinceLastBlock ?? null,
                            mainEventLoopSuspensionCount: mainLoop?.suspensionCount ?? null,
                        },
                    },
                );
            return;
        }
        if (diagnostic.kind === 'terminal-resize-burst') {
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
            return;
        }
        if (diagnostic.kind === 'terminal-osc52-clipboard-write-failure') {
            options
                .logger()
                ?.write('warn', logEventCatalog.renderer.terminalOsc52ClipboardWriteFailed, {
                    fields: {
                        code: 'TERMINAL_OSC52_CLIPBOARD_WRITE_FAILED',
                        diagnosticId: diagnostic.diagnosticId,
                        terminalId: diagnostic.terminalId,
                        errorCategory: diagnostic.errorCategory,
                        clipboardWritePermission: diagnostic.clipboardWritePermission,
                        documentVisible: diagnostic.documentVisible,
                        documentFocused: diagnostic.documentFocused,
                        secureContext: diagnostic.secureContext,
                        terminalFocused: diagnostic.terminalFocused,
                        userActivationActive: diagnostic.userActivationActive,
                        userActivationHasBeenActive: diagnostic.userActivationHasBeenActive,
                    },
                });
            return;
        }
        const {
            react,
            requests,
            longAnimationFrames,
            interactions,
            frames,
            capabilities,
            terminals,
        } = diagnostic;
        options.logger()?.write('info', logEventCatalog.renderer.performanceScenario, {
            correlationId: diagnostic.scenarioId,
            durationMs: diagnostic.durationMs,
            fields: {
                code: 'RENDERER_PERFORMANCE_SCENARIO',
                diagnosticId: diagnostic.diagnosticId,
                entry: diagnostic.entry,
                action: diagnostic.action,
                buildMode: diagnostic.buildMode,
                documentVisible: diagnostic.documentVisible,
                documentFocused: diagnostic.documentFocused,
                visibilityInterrupted: diagnostic.visibilityInterrupted,
                focusInterrupted: diagnostic.focusInterrupted,
                longAnimationFrameCapability: capabilities.longAnimationFrame,
                eventTimingCapability: capabilities.eventTiming,
                reactProfilerCapability: capabilities.reactProfiler,
                reactCommitCount: react.commitCount,
                reactProfiledRenderCount: react.profiledRenderCount,
                reactMountRenderCount: react.mountRenderCount,
                reactUpdateRenderCount: react.updateRenderCount,
                reactNestedUpdateRenderCount: react.nestedUpdateRenderCount,
                reactActualDurationP50Ms: react.actualDurationP50Ms,
                reactActualDurationP95Ms: react.actualDurationP95Ms,
                reactActualDurationMaxMs: react.actualDurationMaxMs,
                reactBaseDurationMaxMs: react.baseDurationMaxMs,
                reactPrimarySidebarRenderCount:
                    react.surfaces['primary-sidebar'].profiledRenderCount,
                reactPrimarySidebarActualDurationP50Ms:
                    react.surfaces['primary-sidebar'].actualDurationP50Ms,
                reactPrimarySidebarActualDurationP95Ms:
                    react.surfaces['primary-sidebar'].actualDurationP95Ms,
                reactPrimarySidebarActualDurationMaxMs:
                    react.surfaces['primary-sidebar'].actualDurationMaxMs,
                reactPrimarySidebarActualDurationTotalMs:
                    react.surfaces['primary-sidebar'].actualDurationTotalMs,
                reactPrimarySidebarBaseDurationMaxMs:
                    react.surfaces['primary-sidebar'].baseDurationMaxMs,
                reactWorkbenchRenderCount: react.surfaces.workbench.profiledRenderCount,
                reactWorkbenchActualDurationP50Ms: react.surfaces.workbench.actualDurationP50Ms,
                reactWorkbenchActualDurationP95Ms: react.surfaces.workbench.actualDurationP95Ms,
                reactWorkbenchActualDurationMaxMs: react.surfaces.workbench.actualDurationMaxMs,
                reactWorkbenchActualDurationTotalMs: react.surfaces.workbench.actualDurationTotalMs,
                reactWorkbenchBaseDurationMaxMs: react.surfaces.workbench.baseDurationMaxMs,
                reactSecondarySidebarRenderCount:
                    react.surfaces['secondary-sidebar'].profiledRenderCount,
                reactSecondarySidebarActualDurationP50Ms:
                    react.surfaces['secondary-sidebar'].actualDurationP50Ms,
                reactSecondarySidebarActualDurationP95Ms:
                    react.surfaces['secondary-sidebar'].actualDurationP95Ms,
                reactSecondarySidebarActualDurationMaxMs:
                    react.surfaces['secondary-sidebar'].actualDurationMaxMs,
                reactSecondarySidebarActualDurationTotalMs:
                    react.surfaces['secondary-sidebar'].actualDurationTotalMs,
                reactSecondarySidebarBaseDurationMaxMs:
                    react.surfaces['secondary-sidebar'].baseDurationMaxMs,
                sessionSelectRequestCount: requests.sessionSelect.count,
                sessionSelectRequestTotalDurationMs: requests.sessionSelect.totalDurationMs,
                sessionSelectRequestMaxDurationMs: requests.sessionSelect.maxDurationMs,
                appBootstrapRequestCount: requests.appBootstrap.count,
                appBootstrapRequestTotalDurationMs: requests.appBootstrap.totalDurationMs,
                appBootstrapRequestMaxDurationMs: requests.appBootstrap.maxDurationMs,
                /**
                 * The keep-alive's own receipt: `terminalReusedCount` beside a non-zero `terminalXtermCreateCount` is a
                 * switch that rebuilt Terminals it was supposed to keep, which no aggregate duration can reveal.
                 */
                terminalAttachedCount: terminals.attachedCount,
                terminalReusedCount: terminals.reusedCount,
                terminalSnapshotReplayCount: terminals.stages.snapshotReplay.count,
                terminalSnapshotReplayTotalDurationMs:
                    terminals.stages.snapshotReplay.totalDurationMs,
                terminalSnapshotReplayMaxDurationMs: terminals.stages.snapshotReplay.maxDurationMs,
                terminalWebglAttachCount: terminals.stages.webglAttach.count,
                terminalWebglAttachTotalDurationMs: terminals.stages.webglAttach.totalDurationMs,
                terminalWebglAttachMaxDurationMs: terminals.stages.webglAttach.maxDurationMs,
                terminalXtermCreateCount: terminals.stages.xtermCreate.count,
                terminalXtermCreateTotalDurationMs: terminals.stages.xtermCreate.totalDurationMs,
                terminalXtermCreateMaxDurationMs: terminals.stages.xtermCreate.maxDurationMs,
                longAnimationFrameCount: longAnimationFrames.count,
                longAnimationFrameTotalDurationMs: longAnimationFrames.totalDurationMs,
                longAnimationFrameMaxDurationMs: longAnimationFrames.maxDurationMs,
                longAnimationFrameTotalBlockingDurationMs:
                    longAnimationFrames.totalBlockingDurationMs,
                longAnimationFrameMaxBlockingDurationMs: longAnimationFrames.maxBlockingDurationMs,
                longAnimationFrameMaxStyleAndLayoutDurationMs:
                    longAnimationFrames.maxStyleAndLayoutDurationMs,
                interactionCount: interactions.count,
                interactionMaxDurationMs: interactions.maxDurationMs,
                interactionMaxInputDelayMs: interactions.maxInputDelayMs,
                interactionMaxProcessingDurationMs: interactions.maxProcessingDurationMs,
                interactionMaxPresentationDelayMs: interactions.maxPresentationDelayMs,
                frameSampleCount: frames.sampleCount,
                frameEstimatedRefreshIntervalMs: frames.estimatedRefreshIntervalMs,
                frameIntervalP50Ms: frames.intervalP50Ms,
                frameIntervalP95Ms: frames.intervalP95Ms,
                frameMaxIntervalMs: frames.maxIntervalMs,
                estimatedMissedFrameCount: frames.missedFrameCount,
                truncated: diagnostic.truncated,
            },
        });
    });
    ipcMain.on('caxri:renderer-events-ready', (event) => {
        if (assertSender(event.sender) === 'companion') {
            options.companion?.onEventsReady();
            return;
        }
        options.onEventsReady?.();
    });
    ipcMain.handle('caxri:request', async (event, raw: unknown): Promise<CaxriReply> => {
        let isTrustedRenderer = false;
        try {
            const role = assertSender(event.sender);
            if (role === 'companion') options.companion?.admit(raw);
            isTrustedRenderer = true;
            /**
             * Refuse queued Renderer work; explicit quit owns final Server I/O and shutdown.
             *
             * Classified as a cancellation rather than an outage because nothing is unavailable and there is nothing to
             * retry: the window that issued the request is being torn down. `UNAVAILABLE` made the Renderer's failure
             * funnel raise a real error notification over a closing window — a read still in flight when the user quits
             * surfaced as "Unable to read directory: Application is quitting".
             */
            if (options.isQuitting())
                return {
                    protocolVersion: CAXRI_PROTOCOL_VERSION,
                    id: requestIdFromEnvelope(raw),
                    ok: false,
                    error: toWireError(new CaxriError('CANCELLED', 'Application is quitting')),
                };
            const reply = await options.transport.dispatch(raw);
            if (role === 'companion' && reply.ok) options.companion?.observeReply?.(raw, reply);
            /**
             * In-flight reads can outlive the window once quit closes the Server attachment; the consumer is gone.
             */
            if (!reply.ok && reply.error.code !== 'CANCELLED' && !options.isQuitting())
                options
                    .logger()
                    ?.write(
                        requestFailureLevel(reply.error.code, options.isRecovering()),
                        logEventCatalog.ipc.requestFailed,
                        {
                            correlationId: requestIdFromEnvelope(raw) ?? undefined,
                            fields: {
                                code: reply.error.code,
                                error: reply.error.message,
                                method: methodFromEnvelope(raw),
                            },
                        },
                    );
            return reply;
        } catch (error) {
            /**
             * Replying with a classified envelope keeps the code intact across the preload.
             */
            const wire = toWireError(error);
            if (wire.code !== 'CANCELLED' && (!isTrustedRenderer || !options.isQuitting()))
                options
                    .logger()
                    ?.write(
                        requestFailureLevel(wire.code, options.isRecovering()),
                        logEventCatalog.ipc.requestFailed,
                        {
                            correlationId: requestIdFromEnvelope(raw) ?? undefined,
                            fields: {
                                code: wire.code,
                                error: wire.message,
                                method: methodFromEnvelope(raw),
                            },
                        },
                    );
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

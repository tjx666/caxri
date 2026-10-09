import { randomUUID } from 'node:crypto';
import { release } from 'node:os';
import process from 'node:process';

import type { TerminalRendererDiagnostic } from '@caxri/protocol';
import type { LogRecord, StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

type LogFields = NonNullable<LogRecord['fields']>;

const CORRELATION_WINDOW_MS = 15_000;
const GPU_INFO_UPDATE_TIMEOUT_MS = 2_000;
const MAX_GPU_FIELD_LENGTH = 512;
const MAX_GPU_INCIDENTS = 8;
const MAX_RENDERER_DIAGNOSTICS = 32;
const MAX_STARTED_SNAPSHOTS = MAX_GPU_INCIDENTS + 1;

interface GpuDiagnosticsApp {
    commandLine: {
        getSwitchValue(name: string): string;
        hasSwitch(name: string): boolean;
    };
    getGPUFeatureStatus(): object;
    getGPUInfo(infoType: 'complete'): Promise<unknown>;
    isHardwareAccelerationEnabled(): boolean;
}

interface GpuDiagnosticsWindow {
    isFocused(): boolean;
    isFullScreen(): boolean;
    isMaximized(): boolean;
    isMinimized(): boolean;
    isSimpleFullScreen(): boolean;
    isVisible(): boolean;
}

export interface GpuProcessGoneDetails {
    exitCode: number;
    name?: string;
    reason: string;
    serviceName?: string;
    type: string;
}

interface GpuDiagnosticsOptions {
    app: GpuDiagnosticsApp;
    architecture?: string;
    createIncidentId?: () => string;
    logger(): StructuredLogger | undefined;
    now?: () => number;
    osRelease?: string;
    platform?: NodeJS.Platform;
    window(): GpuDiagnosticsWindow | undefined;
}

interface RecentGpuIncident {
    id: string;
    occurredAt: number;
}

interface RecentRendererDiagnostic {
    diagnostic: TerminalRendererDiagnostic;
    receivedAt: number;
}

/**
 * The `powerMonitor` events that end a period in which the GPU may have been powered down or switched.
 */
export type SystemWakeKind = 'resume' | 'unlock-screen';

/**
 * Main-owned context a Renderer cannot observe: when the system last woke and when the GPU process last died. Stamped
 * onto every Terminal renderer record so one context-loss line can separate a GPU process reset, a sleep/wake cycle,
 * and Chromium's live-context cap (`liveWebglContextCount`) without joining logs by timestamp.
 */
interface CauseContext {
    gpuProcessGoneCount: number;
    lastGpuProcessGoneAt: number | undefined;
    lastResumeAt: number | undefined;
    lastUnlockAt: number | undefined;
    systemResumeCount: number;
}

function elapsedMs(since: number | undefined, now: number): number | null {
    return since === undefined ? null : Math.max(0, now - since);
}

function systemWakeFields(context: CauseContext, now: number): LogFields {
    return {
        msSinceSystemResume: elapsedMs(context.lastResumeAt, now),
        msSinceScreenUnlock: elapsedMs(context.lastUnlockAt, now),
        systemResumeCount: context.systemResumeCount,
    };
}

const FEATURE_FIELDS: Record<string, string> = {
    '2d_canvas': 'feature2dCanvas',
    'direct_rendering_display_compositor': 'featureDirectRenderingDisplayCompositor',
    'gpu_compositing': 'featureGpuCompositing',
    'multiple_raster_threads': 'featureMultipleRasterThreads',
    'rasterization': 'featureRasterization',
    'skia_graphite': 'featureSkiaGraphite',
    'trees_in_viz': 'featureTreesInViz',
    'video_decode': 'featureVideoDecode',
    'video_encode': 'featureVideoEncode',
    'webgl': 'featureWebgl',
    'webgl2': 'featureWebgl2',
    'webgpu': 'featureWebgpu',
};

function record(value: unknown): Record<string, unknown> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
}

function boundedString(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    return value.slice(0, MAX_GPU_FIELD_LENGTH);
}

function scalar(value: unknown): string | number | boolean | null | undefined {
    if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null
    )
        return typeof value === 'string' ? boundedString(value) : value;
    return undefined;
}

function definedFields(
    fields: Record<string, string | number | boolean | null | undefined>,
): LogFields {
    return Object.fromEntries(
        Object.entries(fields).filter(
            (entry): entry is [string, string | number | boolean | null] => entry[1] !== undefined,
        ),
    );
}

function commandLineFields(app: GpuDiagnosticsApp): LogFields {
    return {
        disableGpu: app.commandLine.hasSwitch('disable-gpu'),
        disableGpuCompositing: app.commandLine.hasSwitch('disable-gpu-compositing'),
        disableSkiaGraphite: app.commandLine.hasSwitch('disable-skia-graphite'),
        enableGpuRasterization: app.commandLine.hasSwitch('enable-gpu-rasterization'),
        useAngle: boundedString(app.commandLine.getSwitchValue('use-angle')) ?? null,
    };
}

function gpuFeatureFields(status: unknown): LogFields {
    const source = record(status) ?? {};
    return definedFields(
        Object.fromEntries(
            Object.entries(FEATURE_FIELDS).map(([feature, field]) => [
                field,
                boundedString(source[feature]),
            ]),
        ),
    );
}

function gpuInfoFields(value: unknown): LogFields {
    const root = record(value) ?? {};
    const devices = Array.isArray(root.gpuDevice) ? root.gpuDevice.map(record) : [];
    const device = devices.find((candidate) => candidate?.active === true) ?? devices[0];
    const attributes = record(root.auxAttributes) ?? {};
    return definedFields({
        gpuVendorId: scalar(device?.vendorId),
        gpuDeviceId: scalar(device?.deviceId),
        gpuDeviceActive: scalar(device?.active),
        gpuVendor: scalar(device?.vendorString),
        gpuDevice: scalar(device?.deviceString),
        gpuDriverVendor: scalar(device?.driverVendor),
        gpuDriverVersion: scalar(device?.driverVersion),
        displayType: scalar(attributes.displayType),
        glImplementation: scalar(attributes.glImplementationParts),
        glRenderer: scalar(attributes.glRenderer),
        glVendor: scalar(attributes.glVendor),
        skiaBackendType: scalar(attributes.skiaBackendType),
        gpuSandboxed: scalar(attributes.sandboxed),
        gpuSoftwareRendering: scalar(attributes.softwareRendering),
        machineModelName: scalar(root.machineModelName),
        machineModelVersion: scalar(root.machineModelVersion),
    });
}

/**
 * Electron exposes the raw waitpid status on POSIX. Decode normal exits separately from signals so a signal number is
 * never mislabeled as a Chromium result code. Chromium result code 34 deliberately restarts the GPU process after a
 * context loss.
 *
 * @see https://www.electronjs.org/docs/latest/api/app#event-child-process-gone
 * @see https://chromium.googlesource.com/chromium/src/+/HEAD/components/viz/service/gl/exit_code.h
 */
function decodeGpuExitStatus(
    exitCode: number,
    platform: NodeJS.Platform,
): {
    code: number | null;
    contextLost: boolean;
    coreDumped: boolean | null;
    name: string | null;
    signal: number | null;
    terminationKind: 'exit-code' | 'signal';
} {
    if (platform !== 'win32') {
        const signal = exitCode & 0x7f;
        if (signal !== 0)
            return {
                code: null,
                contextLost: false,
                coreDumped: (exitCode & 0x80) !== 0,
                name: null,
                signal,
                terminationKind: 'signal',
            };
    }
    const code = platform === 'win32' ? exitCode : (exitCode >>> 8) & 0xff;
    return {
        code,
        contextLost: code === 34,
        coreDumped: platform === 'win32' ? null : false,
        name: code === 34 ? 'RESULT_CODE_GPU_EXIT_ON_CONTEXT_LOST' : null,
        signal: null,
        terminationKind: 'exit-code',
    };
}

function rendererDiagnosticFields(
    diagnostic: TerminalRendererDiagnostic,
    context: CauseContext,
    now: number,
): LogFields {
    return {
        code: 'TERMINAL_RENDERER_STATUS',
        diagnosticId: diagnostic.diagnosticId,
        terminalId: diagnostic.terminalId,
        mode: diagnostic.mode,
        reason: diagnostic.reason,
        trigger: diagnostic.trigger,
        preference: diagnostic.preference,
        contextLossCount: diagnostic.contextLossCount,
        redrawCount: diagnostic.redrawCount,
        visibilityRestoreCoalescedCount: diagnostic.visibilityRestoreCoalescedCount,
        liveWebglContextCount: diagnostic.liveWebglContextCount,
        recoveryResult: diagnostic.recoveryResult,
        retryAttemptCount: diagnostic.retryAttemptCount,
        retryDelayMs: diagnostic.retryDelayMs,
        retryLimit: diagnostic.retryLimit,
        retrySequenceId: diagnostic.retrySequenceId ?? null,
        retryState: diagnostic.retryState,
        receivedBytes: diagnostic.receivedBytes,
        droppedBytes: diagnostic.droppedBytes,
        paneActive: diagnostic.paneActive,
        terminalProcessRunning: diagnostic.terminalProcessRunning,
        agentTerminal: diagnostic.agentTerminal,
        documentVisible: diagnostic.documentVisible,
        documentFocused: diagnostic.documentFocused,
        terminalFocused: diagnostic.terminalFocused,
        ...systemWakeFields(context, now),
        msSinceGpuProcessGone: elapsedMs(context.lastGpuProcessGoneAt, now),
        gpuProcessGoneCount: context.gpuProcessGoneCount,
    };
}

const WEBGL_CREATION_TRIGGERS: ReadonlySet<TerminalRendererDiagnostic['trigger']> = new Set([
    'manual-retry',
    'webgl-load-failed',
    'webgl-reprobe-succeeded',
    'webgl-retry-attempt',
]);

/**
 * Triggers that construct a WebGL context: a fresh activation on preference change, a successful re-probe after window
 * restore, and every bounded retry attempt. `preference-change` also fires for an already-active renderer, so the count
 * is an upper bound on creations.
 */
function isWebglCreationAttempt(diagnostic: TerminalRendererDiagnostic): boolean {
    if (WEBGL_CREATION_TRIGGERS.has(diagnostic.trigger)) return true;
    return diagnostic.trigger === 'preference-change' && diagnostic.mode === 'webgl';
}

/**
 * The latest diagnostic explains what one pane did right before the GPU process died; the window aggregates say how
 * many panes took part and how many WebGL contexts were being rebuilt, which a single record cannot show. The counts
 * are always present so "no Renderer activity" reads as zero rather than as a missing field.
 */
function relatedRendererFields(
    recentDiagnostics: RecentRendererDiagnostic[],
    lastEvictedAt: number | undefined,
    now: number,
): LogFields {
    const inWindow = recentDiagnostics.filter(({ receivedAt }) => {
        const ageMs = now - receivedAt;
        return ageMs >= 0 && ageMs <= CORRELATION_WINDOW_MS;
    });
    /**
     * The ring buffer keeps Main memory bounded during a GPU storm, so it stays at 32 entries instead of growing with
     * split count. When the most recently evicted diagnostic would still fall inside the window, in-window diagnostics
     * were dropped and every count here is a lower bound; the marker makes that truncation visible. A buffer that
     * merely filled up without evicting anything is still exact.
     */
    const saturation =
        lastEvictedAt !== undefined && now - lastEvictedAt <= CORRELATION_WINDOW_MS
            ? 'buffer-limit'
            : 'none';
    const terminalIds = new Set(inWindow.map((entry) => entry.diagnostic.terminalId));
    const counts: LogFields = {
        relatedRendererDiagnosticCount: inWindow.length,
        relatedRendererTerminalCount: terminalIds.size,
        relatedRendererWebglCreationCount: inWindow.filter((entry) =>
            isWebglCreationAttempt(entry.diagnostic),
        ).length,
        relatedRendererVisibilityRestoreCount: inWindow.filter(
            (entry) => entry.diagnostic.trigger === 'visibility-restore',
        ).length,
        relatedRendererSaturation: saturation,
    };
    const recent = inWindow.at(-1);
    if (!recent) return counts;
    const ageMs = now - recent.receivedAt;
    const diagnostic = recent.diagnostic;
    return {
        ...counts,
        // Renderer-lifetime aggregate, unlike the window-scoped counts above; the name keeps the two from being ratioed.
        relatedRendererLifetimeVisibilityRestoreCoalescedCount:
            diagnostic.visibilityRestoreCoalescedCount,
        relatedRendererDiagnosticId: diagnostic.diagnosticId,
        relatedRendererAgeMs: ageMs,
        relatedTerminalId: diagnostic.terminalId,
        relatedRendererMode: diagnostic.mode,
        relatedRendererReason: diagnostic.reason,
        relatedRendererTrigger: diagnostic.trigger,
        relatedRendererPreference: diagnostic.preference,
        relatedRendererContextLossCount: diagnostic.contextLossCount,
        relatedRendererLiveWebglContextCount: diagnostic.liveWebglContextCount,
        relatedRendererRetryAttemptCount: diagnostic.retryAttemptCount,
        relatedRendererRetrySequenceId: diagnostic.retrySequenceId ?? null,
        relatedRendererRetryState: diagnostic.retryState,
        relatedPaneActive: diagnostic.paneActive,
        relatedDocumentVisible: diagnostic.documentVisible,
        relatedDocumentFocused: diagnostic.documentFocused,
        relatedTerminalFocused: diagnostic.terminalFocused,
    };
}

function windowFields(window: GpuDiagnosticsWindow | undefined): LogFields {
    if (!window) return { windowAvailable: false };
    return {
        windowAvailable: true,
        windowFocused: window.isFocused(),
        windowVisible: window.isVisible(),
        windowMinimized: window.isMinimized(),
        windowMaximized: window.isMaximized(),
        windowFullScreen: window.isFullScreen(),
        windowSimpleFullScreen: window.isSimpleFullScreen(),
    };
}

function errorName(error: unknown): string {
    return error instanceof Error && error.name ? error.name : 'UnknownError';
}

export function createGpuDiagnostics(options: GpuDiagnosticsOptions) {
    const architecture = options.architecture ?? process.arch;
    const createIncidentId = options.createIncidentId ?? randomUUID;
    const now = options.now ?? Date.now;
    const operatingSystemRelease = options.osRelease ?? release();
    const platform = options.platform ?? process.platform;
    const recentGpuIncidents: RecentGpuIncident[] = [];
    const recentRendererDiagnostics: RecentRendererDiagnostic[] = [];
    let lastEvictedRendererDiagnosticAt: number | undefined;
    const causeContext: CauseContext = {
        gpuProcessGoneCount: 0,
        lastGpuProcessGoneAt: undefined,
        lastResumeAt: undefined,
        lastUnlockAt: undefined,
        systemResumeCount: 0,
    };
    let previousFeatureFields: LogFields | undefined;
    let isGpuInfoUpdateObserved = false;
    const pendingIncidentTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const startedSnapshots = new Set<string>();

    async function captureSnapshot(
        incidentId: string | undefined,
        wasGpuInfoUpdateObserved: boolean,
    ): Promise<void> {
        const key = incidentId ?? 'baseline';
        if (startedSnapshots.has(key)) return;
        const logger = options.logger();
        if (!logger) return;
        startedSnapshots.add(key);
        if (startedSnapshots.size > MAX_STARTED_SNAPSHOTS)
            startedSnapshots.delete(startedSnapshots.values().next().value!);
        try {
            const featureFields = gpuFeatureFields(options.app.getGPUFeatureStatus());
            const changedFeatureCount = previousFeatureFields
                ? Object.keys(featureFields).filter(
                      (field) => featureFields[field] !== previousFeatureFields?.[field],
                  ).length
                : 0;
            const hardwareAccelerationEnabled = options.app.isHardwareAccelerationEnabled();
            const gpuInfo = await options.app.getGPUInfo('complete');
            logger.write('info', logEventCatalog.gpu.snapshot, {
                correlationId: incidentId,
                fields: {
                    code: 'GPU_SNAPSHOT',
                    scope: incidentId ? 'incident' : 'baseline',
                    gpuInfoUpdateObserved: wasGpuInfoUpdateObserved,
                    platform,
                    architecture,
                    osRelease: operatingSystemRelease,
                    hardwareAccelerationEnabled,
                    changedFeatureCount,
                    ...commandLineFields(options.app),
                    ...featureFields,
                    ...gpuInfoFields(gpuInfo),
                },
            });
            previousFeatureFields = featureFields;
        } catch (error) {
            logger.write('warn', logEventCatalog.gpu.snapshotFailed, {
                correlationId: incidentId,
                fields: {
                    code: 'GPU_SNAPSHOT_FAILED',
                    scope: incidentId ? 'incident' : 'baseline',
                    gpuInfoUpdateObserved: wasGpuInfoUpdateObserved,
                    errorName: errorName(error),
                },
            });
        }
    }

    function recordRendererDiagnostic(diagnostic: TerminalRendererDiagnostic): void {
        const receivedAt = now();
        recentRendererDiagnostics.push({ diagnostic, receivedAt });
        if (recentRendererDiagnostics.length > MAX_RENDERER_DIAGNOSTICS)
            lastEvictedRendererDiagnosticAt = recentRendererDiagnostics.shift()?.receivedAt;
        const explicitIncident = diagnostic.correlationId
            ? recentGpuIncidents.findLast((incident) => incident.id === diagnostic.correlationId)
            : undefined;
        const correlated =
            explicitIncident ??
            recentGpuIncidents.findLast(
                (incident) =>
                    receivedAt >= incident.occurredAt &&
                    receivedAt - incident.occurredAt <= CORRELATION_WINDOW_MS,
            );
        const isFailure = [
            'webgl-context-loss',
            'webgl-load-failed',
            'atlas-clear-failed',
            'webgl-retry-exhausted',
            'webgl-retry-failed',
        ].includes(diagnostic.trigger);
        const isRetry = diagnostic.trigger.startsWith('webgl-retry-');
        if (!isFailure && !isRetry && !correlated) return;
        options
            .logger()
            ?.write(isFailure ? 'warn' : 'info', logEventCatalog.renderer.terminalRendererStatus, {
                correlationId: correlated?.id,
                fields: rendererDiagnosticFields(diagnostic, causeContext, receivedAt),
            });
        if (correlated)
            options.logger()?.write('info', logEventCatalog.gpu.recovery, {
                correlationId: correlated.id,
                fields: {
                    code: 'GPU_RECOVERY',
                    diagnosticId: diagnostic.diagnosticId,
                    terminalId: diagnostic.terminalId,
                    rendererMode: diagnostic.mode,
                    rendererReason: diagnostic.reason,
                    rendererTrigger: diagnostic.trigger,
                    recoveryResult: diagnostic.recoveryResult,
                    retryAttemptCount: diagnostic.retryAttemptCount,
                    retryDelayMs: diagnostic.retryDelayMs,
                    retryLimit: diagnostic.retryLimit,
                    retrySequenceId: diagnostic.retrySequenceId ?? null,
                    retryState: diagnostic.retryState,
                    receivedBytes: diagnostic.receivedBytes,
                    droppedBytes: diagnostic.droppedBytes,
                    terminalProcessRunning: diagnostic.terminalProcessRunning,
                    terminalFocused: diagnostic.terminalFocused,
                },
            });
    }

    function recordGpuProcessGone(
        details: GpuProcessGoneDetails,
    ): { contextLost: boolean; correlationId: string } | undefined {
        if (details.type !== 'GPU' || details.reason === 'clean-exit') return undefined;
        const occurredAt = now();
        const incidentId = createIncidentId();
        causeContext.gpuProcessGoneCount += 1;
        causeContext.lastGpuProcessGoneAt = occurredAt;
        recentGpuIncidents.push({ id: incidentId, occurredAt });
        if (recentGpuIncidents.length > MAX_GPU_INCIDENTS) recentGpuIncidents.shift();
        const result = decodeGpuExitStatus(details.exitCode, platform);
        options.logger()?.write('error', logEventCatalog.gpu.processGone, {
            correlationId: incidentId,
            fields: {
                code: 'GPU_PROCESS_GONE',
                type: details.type,
                reason: details.reason,
                exitCode: details.exitCode,
                chromiumResultCode: result.code,
                chromiumResultName: result.name,
                contextLost: result.contextLost,
                terminationKind: result.terminationKind,
                posixSignal: result.signal,
                coreDumped: result.coreDumped,
                ...(details.name && { name: boundedString(details.name) ?? details.name }),
                ...(details.serviceName && {
                    serviceName: boundedString(details.serviceName) ?? details.serviceName,
                }),
                platform,
                architecture,
                osRelease: operatingSystemRelease,
                ...commandLineFields(options.app),
                ...windowFields(options.window()),
                ...systemWakeFields(causeContext, occurredAt),
                gpuProcessGoneCount: causeContext.gpuProcessGoneCount,
                ...relatedRendererFields(
                    recentRendererDiagnostics,
                    lastEvictedRendererDiagnosticAt,
                    occurredAt,
                ),
            },
        });
        const timer = setTimeout(() => {
            pendingIncidentTimers.delete(incidentId);
            // The event listener cannot await; a failed snapshot writes its own bounded diagnostic.
            // eslint-disable-next-line no-void -- intentionally asynchronous timeout fallback
            void captureSnapshot(incidentId, false);
        }, GPU_INFO_UPDATE_TIMEOUT_MS);
        pendingIncidentTimers.set(incidentId, timer);
        return { contextLost: result.contextLost, correlationId: incidentId };
    }

    async function handleGpuInfoUpdate(): Promise<void> {
        isGpuInfoUpdateObserved = true;
        if (pendingIncidentTimers.size === 0) {
            await captureSnapshot(undefined, true);
            return;
        }
        const incidents = [...pendingIncidentTimers];
        pendingIncidentTimers.clear();
        await Promise.all(
            incidents.map(([incidentId, timer]) => {
                clearTimeout(timer);
                return captureSnapshot(incidentId, true);
            }),
        );
    }

    /**
     * Records the moment of a wake; the event itself is not logged because Main's event-loop monitor already counts
     * suspensions, and the elapsed time only matters next to a GPU or Terminal renderer record.
     */
    function recordSystemWake(kind: SystemWakeKind): void {
        const at = now();
        if (kind === 'resume') {
            causeContext.lastResumeAt = at;
            causeContext.systemResumeCount += 1;
            return;
        }
        causeContext.lastUnlockAt = at;
    }

    return {
        captureBaseline: () =>
            isGpuInfoUpdateObserved ? captureSnapshot(undefined, true) : Promise.resolve(),
        handleGpuInfoUpdate,
        recordGpuProcessGone,
        recordRendererDiagnostic,
        recordSystemWake,
    };
}

import { randomUUID } from 'node:crypto';
import { release } from 'node:os';
import process from 'node:process';

import type { LogRecord, StructuredLogger } from '../shared/node/logger';
import { logEventCatalog } from '../shared/node/logger';
import type { RendererDiagnostic } from '../shared/renderer-diagnostic';

type LogFields = NonNullable<LogRecord['fields']>;

const CORRELATION_WINDOW_MS = 15_000;
const GPU_INFO_UPDATE_TIMEOUT_MS = 2_000;
const MAX_GPU_FIELD_LENGTH = 512;

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
    diagnostic: RendererDiagnostic;
    receivedAt: number;
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

function gpuFeatureFields(status: object): LogFields {
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

function rendererDiagnosticFields(diagnostic: RendererDiagnostic): LogFields {
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
        paneActive: diagnostic.paneActive,
        terminalProcessRunning: diagnostic.terminalProcessRunning,
        agentTerminal: diagnostic.agentTerminal,
        documentVisible: diagnostic.documentVisible,
        documentFocused: diagnostic.documentFocused,
        terminalFocused: diagnostic.terminalFocused,
    };
}

function relatedRendererFields(
    recent: RecentRendererDiagnostic | undefined,
    now: number,
): LogFields {
    if (!recent) return {};
    const ageMs = now - recent.receivedAt;
    if (ageMs < 0 || ageMs > CORRELATION_WINDOW_MS) return {};
    const diagnostic = recent.diagnostic;
    return {
        relatedRendererDiagnosticId: diagnostic.diagnosticId,
        relatedRendererAgeMs: ageMs,
        relatedTerminalId: diagnostic.terminalId,
        relatedRendererMode: diagnostic.mode,
        relatedRendererReason: diagnostic.reason,
        relatedRendererTrigger: diagnostic.trigger,
        relatedRendererPreference: diagnostic.preference,
        relatedRendererContextLossCount: diagnostic.contextLossCount,
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
    let recentGpuIncident: RecentGpuIncident | undefined;
    let recentRendererDiagnostic: RecentRendererDiagnostic | undefined;
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
        try {
            const featureFields = gpuFeatureFields(options.app.getGPUFeatureStatus());
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
                    ...commandLineFields(options.app),
                    ...featureFields,
                    ...gpuInfoFields(gpuInfo),
                },
            });
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

    function recordRendererDiagnostic(diagnostic: RendererDiagnostic): void {
        const receivedAt = now();
        recentRendererDiagnostic = { diagnostic, receivedAt };
        const incident = recentGpuIncident;
        const correlated =
            incident &&
            receivedAt >= incident.occurredAt &&
            receivedAt - incident.occurredAt <= CORRELATION_WINDOW_MS
                ? incident
                : undefined;
        const isFailure = [
            'webgl-context-loss',
            'webgl-load-failed',
            'atlas-clear-failed',
        ].includes(diagnostic.trigger);
        if (!isFailure && !correlated) return;
        options
            .logger()
            ?.write(isFailure ? 'warn' : 'info', logEventCatalog.renderer.terminalRendererStatus, {
                correlationId: correlated?.id,
                fields: rendererDiagnosticFields(diagnostic),
            });
    }

    function recordGpuProcessGone(details: GpuProcessGoneDetails): string | undefined {
        if (details.type !== 'GPU' || details.reason === 'clean-exit') return undefined;
        const occurredAt = now();
        const incidentId = createIncidentId();
        recentGpuIncident = { id: incidentId, occurredAt };
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
                ...relatedRendererFields(recentRendererDiagnostic, occurredAt),
            },
        });
        const timer = setTimeout(() => {
            pendingIncidentTimers.delete(incidentId);
            // The event listener cannot await; a failed snapshot writes its own bounded diagnostic.
            // eslint-disable-next-line no-void -- intentionally asynchronous timeout fallback
            void captureSnapshot(incidentId, false);
        }, GPU_INFO_UPDATE_TIMEOUT_MS);
        pendingIncidentTimers.set(incidentId, timer);
        return incidentId;
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

    return {
        captureBaseline: () =>
            isGpuInfoUpdateObserved ? captureSnapshot(undefined, true) : Promise.resolve(),
        handleGpuInfoUpdate,
        recordGpuProcessGone,
        recordRendererDiagnostic,
    };
}

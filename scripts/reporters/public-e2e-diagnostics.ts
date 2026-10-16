import { errorCodes, isCaxriMethod, isLogProcess, logEventNames } from '@caxri/protocol';
import type { E2EErrorAllowance, E2EErrorEvent } from '@caxri/system';

interface Annotation {
    type: string;
    description?: string;
}

const gateAnnotation = 'caxri-public-error-gate';
const timingAnnotation = 'caxri-public-timings';
const gatePhases = [
    'body-failed',
    'finalize-failed',
    'cleanup-failed',
    'capture-failed',
    'policy-rejected',
] as const;
type GatePhase = (typeof gatePhases)[number];

const launchStages = [
    'freshnessMs',
    'agentEnvironmentMs',
    'leaseAcquireMs',
    'leaseHandoffMs',
    'electronLaunchMs',
    'errorGateRegisterMs',
    'lifecycleSetupMs',
    'leaseTransferMs',
    'firstWindowMs',
    'runtimeStatusWaitMs',
] as const;
export type PublicE2ELaunchStage = (typeof launchStages)[number];

export function createE2ELaunchTimer(
    report: ((stage: PublicE2ELaunchStage, durationMs: number) => void) | undefined,
) {
    let previous = performance.now();
    return (stage: PublicE2ELaunchStage): void => {
        const now = performance.now();
        report?.(stage, now - previous);
        previous = now;
    };
}

const timingFields = {
    agentLaunch: launchStages,
    coldLaunch: launchStages,
    restoredLaunch: launchStages,
    coldProfile: [
        'mainModuleMs',
        'appReadyMs',
        'serverAttachedMs',
        'windowCreatedMs',
        'readyToShowMs',
        'windowShownMs',
        'rendererReadyMs',
        'loaderRemovedMs',
        'firstFrameMs',
    ],
    benchmark: [
        'launchHelperMs',
        'packagedDialogStubMs',
        'runtimeStatusWaitMs',
        'runtimeReadyMs',
        'terminalReadyMs',
        'terminalEchoMs',
        'filesReadyMs',
        'gitReadyMs',
        'restoredRuntimeReadyMs',
        'restoredTerminalSurfaceMs',
        'restoredTerminalReadyMs',
        'restoredFilesReadyMs',
        'restoredGitReadyMs',
        'serverCoreBootMs',
        'terminalSpawnMs',
        'fileListMs',
        'gitSummaryMs',
        'windowReadyMs',
        'ipcFailures',
    ],
} as const;
type TimingScope = keyof typeof timingFields;
const publicEvents = new Set<string>([...logEventNames, 'console', 'pageerror', 'toast']);
const publicCodes = new Set<string>([...errorCodes, 'CONSOLE_ERROR', 'PAGE_ERROR', 'ERROR_TOAST']);

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/**
 * Unknown log strings collapse to a sentinel; only public protocol enums may become count dimensions.
 */
function errorCounts(value: unknown) {
    const published = record(value);
    const entries = Array.isArray(value) ? value : published?.groups;
    const rows = Array.isArray(entries) ? entries : [];
    const groups = new Map<
        string,
        { source: string; event: string; code: string; method?: string; count: number }
    >();
    let total = 0;
    for (const entry of rows) {
        const row = record(entry);
        if (!row) continue;
        const count = row.count ?? 1;
        if (
            typeof count !== 'number' ||
            !Number.isSafeInteger(count) ||
            count <= 0 ||
            count > 1_000_000_000
        )
            continue;
        const source = row.source === 'renderer' || isLogProcess(row.source) ? row.source : 'other';
        const event =
            typeof row.event === 'string' && publicEvents.has(row.event) ? row.event : 'other';
        const code = typeof row.code === 'string' && publicCodes.has(row.code) ? row.code : 'other';
        const method =
            typeof row.method === 'string' && isCaxriMethod(row.method) ? row.method : undefined;
        const key = JSON.stringify([source, event, code, method]);
        const previous = groups.get(key);
        groups.set(key, {
            source,
            event,
            code,
            ...(method && { method }),
            count: (previous?.count ?? 0) + count,
        });
        total += count;
    }
    const publishedTotal = published?.total;
    const publishedOmitted = published?.omittedGroups;
    return {
        total:
            typeof publishedTotal === 'number' &&
            Number.isSafeInteger(publishedTotal) &&
            publishedTotal >= total &&
            publishedTotal <= 1_000_000_000_000
                ? publishedTotal
                : total,
        groups: groups.values().toArray().slice(0, 100),
        omittedGroups:
            Math.max(0, groups.size - 100) +
            (typeof publishedOmitted === 'number' &&
            Number.isSafeInteger(publishedOmitted) &&
            publishedOmitted >= 0 &&
            publishedOmitted <= 1_000_000
                ? publishedOmitted
                : 0),
    };
}

function safeGate(value: unknown) {
    const row = record(value);
    if (!row || !gatePhases.includes(row.phase as GatePhase)) return;
    return {
        phase: row.phase as GatePhase,
        actual: errorCounts(row.actual),
        expected: errorCounts(row.expected),
    };
}

function safeTiming(value: unknown) {
    const row = record(value);
    if (!row || typeof row.scope !== 'string' || !Object.hasOwn(timingFields, row.scope)) return;
    const scope = row.scope as TimingScope;
    const values = record(row.values);
    const safeValues: Record<string, number> = {};
    const fields = timingFields[scope];
    for (const field of fields) {
        const number = values?.[field];
        if (
            typeof number === 'number' &&
            Number.isFinite(number) &&
            number >= 0 &&
            number <= 600_000
        )
            safeValues[field] = Math.round(number * 100) / 100;
    }
    return Object.keys(safeValues).length > 0 ? { scope, values: safeValues } : undefined;
}

export function annotateE2EGateFailure(
    info: { annotations: Annotation[] },
    phase: GatePhase,
    actual: readonly E2EErrorEvent[] = [],
    expected: readonly E2EErrorAllowance[] = [],
): void {
    // Keep the worker annotation safe too; a different reporter must not recover arbitrary log values.
    const diagnostic = safeGate({ phase, actual, expected });
    info.annotations.push({ type: gateAnnotation, description: JSON.stringify(diagnostic) });
}

export function annotateE2ETimings(
    info: { annotations: Annotation[] },
    scope: TimingScope,
    values: Record<string, unknown>,
): void {
    const diagnostic = safeTiming({ scope, values });
    if (diagnostic)
        info.annotations.push({ type: timingAnnotation, description: JSON.stringify(diagnostic) });
}

/**
 * Revalidate dedicated worker annotations; never echo arbitrary annotations, stdout, or failure messages.
 */
export function readPublicE2EDiagnostics(annotations: readonly Annotation[] = []) {
    const gateFailures: Array<NonNullable<ReturnType<typeof safeGate>>> = [];
    const timings: Partial<Record<TimingScope, Record<string, number>>> = {};
    for (const annotation of annotations.slice(0, 100)) {
        if (!annotation.description || annotation.description.length > 40_000) continue;
        if (annotation.type !== gateAnnotation && annotation.type !== timingAnnotation) continue;
        let value: unknown;
        try {
            value = JSON.parse(annotation.description);
        } catch {
            continue;
        }
        if (annotation.type === gateAnnotation) {
            const diagnostic = safeGate(value);
            if (diagnostic) gateFailures.push(diagnostic);
        } else {
            const diagnostic = safeTiming(value);
            if (diagnostic)
                timings[diagnostic.scope] = { ...timings[diagnostic.scope], ...diagnostic.values };
        }
    }
    return {
        ...(gateFailures.length > 0 && { gateFailures }),
        ...(Object.keys(timings).length > 0 && { timings }),
    };
}

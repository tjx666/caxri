interface Annotation {
    type: string;
    description?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

const launchAnnotation = 'caxri-public-launch';

export const publicE2ELaunchStages = [
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
export type PublicE2ELaunchStage = (typeof publicE2ELaunchStages)[number];

export const publicE2EExitSignals = ['SIGABRT', 'SIGKILL', 'SIGSEGV', 'SIGTERM'] as const;

/**
 * Closed projection of how the Electron process ended: a bounded exit code and one of four fatal signals. Anything else
 * collapses to `null` so a platform-specific string can never leave the worker.
 */
export interface PublicE2EProcessExit {
    code: number | null;
    signal: (typeof publicE2EExitSignals)[number] | null;
}

/**
 * What the launch helper learned before the test failed: the last stage that completed and how the Electron process
 * ended, if it did. Both are closed values, never text.
 */
export interface PublicE2ELaunchState {
    exit?: PublicE2EProcessExit;
    stage?: PublicE2ELaunchStage;
}

export function safeProcessExit(code: unknown, signal: unknown): PublicE2EProcessExit {
    return {
        code:
            typeof code === 'number' && Number.isSafeInteger(code) && code >= 0 && code <= 255
                ? code
                : null,
        signal: publicE2EExitSignals.find((candidate) => candidate === signal) ?? null,
    };
}

function safeLaunch(value: unknown): PublicE2ELaunchState | undefined {
    const row = record(value);
    if (!row) return undefined;
    const stage = publicE2ELaunchStages.find((candidate) => candidate === row.stage);
    const exitRow = record(row.exit);
    const exit = exitRow ? safeProcessExit(exitRow.code, exitRow.signal) : undefined;
    return stage || exit ? { ...(exit && { exit }), ...(stage && { stage }) } : undefined;
}

export function annotateE2ELaunch(info: { annotations: Annotation[] }, state: unknown): void {
    const diagnostic = safeLaunch(state);
    if (diagnostic)
        info.annotations.push({ type: launchAnnotation, description: JSON.stringify(diagnostic) });
}

/**
 * Revalidates the launch annotation; the last one wins because a spec may relaunch.
 */
export function readPublicE2ELaunch(
    annotations: readonly Annotation[] = [],
): PublicE2ELaunchState | undefined {
    let launch: PublicE2ELaunchState | undefined;
    for (const annotation of annotations.slice(0, 100)) {
        if (annotation.type !== launchAnnotation || !annotation.description) continue;
        if (annotation.description.length > 1000) continue;
        try {
            launch = safeLaunch(JSON.parse(annotation.description)) ?? launch;
        } catch {
            continue;
        }
    }
    return launch;
}

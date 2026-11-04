import type { WorkbenchComposedReadDiagnostic } from '@caxri/protocol';

/**
 * A read that missed the Renderer's slow budget is a refresh the user waited on, so it logs at `warn`; a periodic
 * sample of a fast read stays `info`.
 */
export function workbenchComposedReadLogLevel(
    diagnostic: WorkbenchComposedReadDiagnostic,
): 'info' | 'warn' {
    return diagnostic.slow ? 'warn' : 'info';
}

/**
 * Scalar log fields for a composed Workbench read: durations and counts only, so no Project, Session, path, or Host
 * name can reach the log through this event.
 */
export function workbenchComposedReadLogFields(
    diagnostic: WorkbenchComposedReadDiagnostic,
    window: string,
): Record<string, boolean | number | string> {
    return {
        code: 'WORKBENCH_COMPOSED_READ',
        diagnosticId: diagnostic.diagnosticId,
        trigger: diagnostic.trigger,
        slow: diagnostic.slow,
        totalMs: diagnostic.totalMs,
        localBootstrapMs: diagnostic.localBootstrapMs,
        remoteReadMs: diagnostic.remoteReadMs,
        connectedHostCount: diagnostic.connectedHostCount,
        remoteReadCount: diagnostic.remoteReadCount,
        composedReadCount: diagnostic.composedReadCount,
        hostChangeReadCount: diagnostic.hostChangeReadCount,
        slowReadCount: diagnostic.slowReadCount,
        window,
    };
}

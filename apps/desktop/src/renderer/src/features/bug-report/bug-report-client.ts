import type { MethodResult, ParametersArgument } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';

/**
 * The Server calls the Bug Report dialog makes. Keeping them here rather than inline in the dialog hook is the boundary
 * `caxri/server-reads-through-query` enforces: a request written inside a component or hook resolves into state that
 * dies with it, and the next feature copies whatever shape it sees.
 *
 * Each wrapper forwards `ParametersArgument` verbatim so the protocol registry stays the single source of truth for
 * these payloads instead of a hand-copied duplicate that can drift.
 */
export function loadBugReportContext(): Promise<MethodResult<'bugReport.context'>> {
    return caxri.request('bugReport.context');
}

export function captureBugReportScreenshot(): Promise<MethodResult<'bugReport.captureScreenshot'>> {
    return caxri.request('bugReport.captureScreenshot');
}

export function saveBugReportScreenshot(
    ...arguments_: ParametersArgument<'bugReport.saveScreenshot'>
): Promise<MethodResult<'bugReport.saveScreenshot'>> {
    return caxri.request('bugReport.saveScreenshot', ...arguments_);
}

export function sendBugReport(
    ...arguments_: ParametersArgument<'bugReport.send'>
): Promise<MethodResult<'bugReport.send'>> {
    return caxri.request('bugReport.send', ...arguments_);
}

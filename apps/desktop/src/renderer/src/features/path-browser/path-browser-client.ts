import type { MethodResult, ParametersArgument } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';

/**
 * The Server calls the Path Browser dialog makes. Keeping them here rather than inline in the dialog hook is the
 * boundary `caxri/server-reads-through-query` enforces: a request written inside a component or hook resolves into
 * state that dies with it, and the next feature copies whatever shape it sees.
 *
 * Each wrapper forwards `ParametersArgument` verbatim so the protocol registry stays the single source of truth for
 * these payloads instead of a hand-copied duplicate that can drift.
 */
export function startPathBrowser(
    ...arguments_: ParametersArgument<'pathBrowser.start'>
): Promise<MethodResult<'pathBrowser.start'>> {
    return caxri.request('pathBrowser.start', ...arguments_);
}

export function browsePath(
    ...arguments_: ParametersArgument<'pathBrowser.browse'>
): Promise<MethodResult<'pathBrowser.browse'>> {
    return caxri.request('pathBrowser.browse', ...arguments_);
}

export function navigatePathBrowser(
    ...arguments_: ParametersArgument<'pathBrowser.navigate'>
): Promise<MethodResult<'pathBrowser.navigate'>> {
    return caxri.request('pathBrowser.navigate', ...arguments_);
}

export function openPathBrowserEntry(
    ...arguments_: ParametersArgument<'pathBrowser.open'>
): Promise<MethodResult<'pathBrowser.open'>> {
    return caxri.request('pathBrowser.open', ...arguments_);
}

export function closePathBrowserSession(
    ...arguments_: ParametersArgument<'pathBrowser.close'>
): Promise<MethodResult<'pathBrowser.close'>> {
    return caxri.request('pathBrowser.close', ...arguments_);
}

import type {
    RuntimeMethod,
    RuntimeMethodResult,
    RuntimeParamsArg as RuntimeParametersArgument,
} from '../registry/methods.js';

/**
 * Runtime operations available only to an authenticated Desktop Main after it has completed the
 * native dialog, grant, or confirmation step. `runtime.shutdown` is intentionally absent: Desktop
 * disconnection must never stop the Host-owned Runtime.
 */
export const desktopRuntimeMethodIds = [
    'app.windowState.get',
    'app.windowState.update',
    'bugReport.deliver',
    'config.paths',
    'settings.trustDomain',
    'diagnostics.exportPath',
    'files.authorizeTrash',
    'files.authorizeOpen',
    'terminal.detachAll',
    'terminal.terminateAll',
    'theme.importPath',
    'project.create',
    'project.delete',
    'session.delete',
    'session.selectWorkbenchRoot',
    'session.workbenchCandidate.claim',
    'session.workbenchCandidate.authorize',
    'session.workbenchCandidate.cancel',
    'session.workbenchRoot.authorizeSelection',
    'session.validateWorkbenchRoots',
] as const satisfies readonly RuntimeMethod[];

export type DesktopRuntimeMethod = (typeof desktopRuntimeMethodIds)[number];
export type DesktopRuntimeParametersArgument<M extends DesktopRuntimeMethod> =
    RuntimeParametersArgument<M>;
export type DesktopRuntimeMethodResult<M extends DesktopRuntimeMethod> = RuntimeMethodResult<M>;

const desktopRuntimeMethodSet = new Set<RuntimeMethod>(desktopRuntimeMethodIds);

export function isDesktopRuntimeMethod(value: string): value is DesktopRuntimeMethod {
    return desktopRuntimeMethodSet.has(value as RuntimeMethod);
}

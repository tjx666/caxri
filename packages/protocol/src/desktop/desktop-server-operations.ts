import type {
    ServerOperation,
    ServerOperationArguments,
    ServerOperationResult,
} from '../registry/methods.js';

/**
 * Server operations available only to authenticated Desktop Main after it completes the native dialog, grant, or
 * confirmation step. Desktop disconnection never stops Server Core.
 */
export const desktopServerOperationIds = [
    'agent.replySummary',
    'app.auxiliaryWindowState.get',
    'app.auxiliaryWindowState.update',
    'app.windowState.get',
    'app.windowState.update',
    'bugReport.deliver',
    'commander.clearData',
    'settings.trustDomain',
    'settings.trustFolder',
    'diagnostics.exportPath',
    'git.discard.preflight',
    'git.discard.apply',
    'mobile.device.revoke.apply',
    'files.authorizeTrash',
    'files.authorizeOpen',
    'files.trashOnHost',
    'terminal.fileLink.resolve',
    'terminal.createInExternalDirectory',
    'terminal.detachAll',
    'terminal.terminateAll',
    'window.closePresence',
    'window.openSessions.listTearOffs',
    'window.openSessions.moveToWindow',
    'window.openSessions.release',
    'window.reportPresence',
    'window.seedPresence',
    'theme.importPath',
    'project.create',
    'project.delete',
    'session.delete',
    'session.deleteMany',
    'session.selectWorkbenchRoot',
    'session.workbenchCandidate.claim',
    'session.workbenchCandidate.authorize',
    'session.workbenchCandidate.cancel',
    'session.workbenchRoot.authorizeSelection',
    'session.workbenchRoot.resolve',
    'session.validateWorkbenchRoots',
] as const satisfies readonly ServerOperation[];

export type DesktopServerOperation = (typeof desktopServerOperationIds)[number];
export type DesktopServerOperationArguments<M extends DesktopServerOperation> =
    ServerOperationArguments<M>;
export type DesktopServerOperationResult<M extends DesktopServerOperation> =
    ServerOperationResult<M>;

const desktopServerOperationSet = new Set<ServerOperation>(desktopServerOperationIds);

export function isDesktopServerOperation(value: string): value is DesktopServerOperation {
    return desktopServerOperationSet.has(value as ServerOperation);
}

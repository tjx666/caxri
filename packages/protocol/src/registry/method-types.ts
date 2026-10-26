import type { z } from 'zod';

import type { CommandRecovery, MethodSpec } from '../transport/method-spec.js';
import { internalMethods, methods } from './method-registry.js';

export type CaxriMethod = keyof typeof methods;
export type EffectfulCaxriMethod = {
    [M in CaxriMethod]: (typeof methods)[M]['effect'] extends 'read' ? never : M;
}[CaxriMethod];
type InternalMethod = keyof typeof internalMethods;
export type ServerOperation = CaxriMethod | InternalMethod;

type DesktopMethod = {
    [M in CaxriMethod]: Extract<(typeof methods)[M]['owner'], 'desktop'> extends never ? never : M;
}[CaxriMethod];

export type ServerMethod = {
    [M in CaxriMethod]: Extract<(typeof methods)[M]['owner'], 'server'> extends never ? never : M;
}[CaxriMethod];

type AllMethods = typeof methods & typeof internalMethods;

/**
 * Parameters as a handler receives them, after Zod applied defaults and coercion.
 */
type MethodParameters<M extends CaxriMethod> = z.infer<(typeof methods)[M]['params']>;
/**
 * Parameters as a caller supplies them; `undefined` is allowed when the schema has a default.
 */
type MethodInput<M extends CaxriMethod> = z.input<(typeof methods)[M]['params']>;
export type MethodResult<M extends CaxriMethod> = z.infer<(typeof methods)[M]['result']>;

export type ServerOperationParameters<M extends ServerOperation> = z.infer<AllMethods[M]['params']>;
type ServerOperationInput<M extends ServerOperation> = z.input<AllMethods[M]['params']>;
export type ServerOperationResult<M extends ServerOperation> = z.infer<AllMethods[M]['result']>;

/**
 * Makes the params argument optional exactly when the method's schema accepts `undefined`.
 */
export type ParametersArgument<M extends CaxriMethod> =
    undefined extends MethodInput<M> ? [params?: MethodInput<M>] : [params: MethodInput<M>];

export type ServerOperationArguments<M extends ServerOperation> =
    undefined extends ServerOperationInput<M>
        ? [params?: ServerOperationInput<M>, timeoutMs?: number]
        : [params: ServerOperationInput<M>, timeoutMs?: number];

/**
 * Discriminated request unions let a `switch` on `method` narrow `params` without a cast.
 */
export type CaxriRequest = {
    [M in CaxriMethod]: { method: M; params: MethodParameters<M> };
}[CaxriMethod];

export type DesktopRequest = Extract<CaxriRequest, { method: DesktopMethod }>;
export type ServerRequest = Extract<CaxriRequest, { method: ServerMethod }>;
/**
 * Compatibility name for the Electron Main adapter; `DesktopRequest` is the architectural term.
 */
export type MainRequest = DesktopRequest;

export type ServerOperationRequest = {
    [M in ServerOperation]: { method: M; params: ServerOperationParameters<M> };
}[ServerOperation];

export function isCaxriMethod(value: string): value is CaxriMethod {
    return Object.hasOwn(methods, value);
}

/**
 * Exhaustive recovery/privacy review for every public effect. New write/control methods fail type checking until their
 * reply is classified. Durable replies may contain only content-free results or metadata already owned by a durable
 * domain record. Memory-only entries include editor bodies, configuration sources, Terminal screens, ephemeral native
 * paths, arbitrary failure messages, or lifecycle semantics tied to one boot.
 */
export const effectfulCommandRecovery = {
    'agentActions.recordRecent': 'none',
    'benchmark.start': 'durable',
    'benchmark.cancel': 'durable',
    'benchmark.delete': 'durable',
    'agentChat.send': 'memory',
    'agentChat.askSideQuestion': 'memory',
    'agentChat.interrupt': 'memory',
    'agentChat.respond': 'memory',
    'agentChat.runCommand': 'memory',
    'agentChat.configure': 'memory',
    'agentChat.continueInAgent': 'durable',
    'agentChat.generateHandoff': 'memory',
    'agentChat.stopTask': 'memory',
    'agentChat.removeQueued': 'memory',
    'agentChat.sendQueuedNow': 'memory',
    'agentChat.resumeQueue': 'memory',
    'agentChat.takeQueued': 'memory',
    'agentChat.restoreQueued': 'memory',
    'agentChat.editQueued': 'memory',
    'agentChat.rewind': 'memory',
    'agentChat.fork': 'durable',
    'agentChat.restoreFiles': 'memory',
    'agentChat.saveLongPaste': 'memory',
    'agent.dispatch.start': 'durable',
    'agent.delegation.create': 'durable',
    'agent.session.rename': 'durable',
    'agent.session.archive': 'durable',
    'agent.session.unarchive': 'durable',
    'commander.ensure': 'memory',
    /**
     * Replies with the same Workbench-shaped snapshot as `commander.ensure`.
     */
    'commander.switchAgent': 'memory',
    'commander.session.create': 'durable',
    'commander.session.archive': 'durable',
    'commander.session.handOver': 'durable',
    'commander.session.takeBack': 'durable',
    'commander.task.create': 'durable',
    'commander.task.update': 'durable',
    'commander.stop': 'durable',
    'commander.inbox.add': 'durable',
    'commander.inbox.resolve': 'durable',
    'commander.inbox.ack': 'durable',
    'commander.inbox.reply': 'durable',
    'commander.inbox.dismiss': 'durable',
    'commander.inbox.merge': 'durable',
    'agent.delegation.access.create': 'memory',
    'agent.delegation.access.revoke': 'memory',
    'agent.delegation.stop': 'durable',
    'agent.dispatch.resume': 'durable',
    'agent.control.interrupt': 'durable',
    'agent.control.stop': 'durable',
    'terminal.send': 'durable',
    'agent.grant': 'durable',
    'agent.revoke': 'durable',
    'agent.message.send': 'durable',
    'agent.message.reply': 'durable',
    'agent.message.policy.set': 'durable',
    'agent.message.approve': 'durable',
    'agent.message.deny': 'durable',
    'settings.patch': 'memory',
    'settings.delegation.import': 'memory',
    'session.selectWorkbenchRoot': 'durable',
    'session.authorizeWorkbenchRoot': 'durable',
    'session.dismissWorkbenchCandidate': 'durable',
    'session.workbenchRoot.forgetEditorPath': 'durable',
    'session.continueInWorktree': 'durable',
    'viewContainers.viewOperation': 'memory',
    'viewContainers.executeCommand': 'durable',
    'viewContainers.cancelRequest': 'durable',
    'requests.cancel': 'durable',
    'extensions.retry': 'memory',
    'host.stop': 'memory',
    'mobile.access.enable': 'memory',
    'mobile.access.disable': 'memory',
    'mobile.pairing.create': 'memory',
    'mobile.device.revoke': 'memory',
    'mobile.session.create': 'durable',
    'mobile.session.rename': 'durable',
    'mobile.session.archive': 'durable',
    'mobile.session.restore': 'durable',
    'mobile.session.setPinned': 'durable',
    'mobile.pullRequest.merge': 'durable',
    'mobile.agent.submit': 'none',
    'mobile.image.upload': 'memory',
    'mobile.attention.answer': 'memory',
    'mobile.attention.autoAllowRevoke': 'memory',
    'mobile.terminal.takeOver': 'none',
    'mobile.terminal.release': 'none',
    'mobile.terminal.input': 'none',
    'mobile.terminal.scroll': 'none',
    'mobile.agentChat.send': 'memory',
    'mobile.agentChat.interrupt': 'memory',
    'mobile.agentChat.stopTask': 'memory',
    'mobile.agentChat.respond': 'memory',
    'mobile.agentChat.retry': 'memory',
    'mobile.agentChat.configure': 'memory',
    'mobile.agentChat.removeQueued': 'memory',
    'mobile.agentChat.sendQueuedNow': 'memory',
    'mobile.agentChat.resumeQueue': 'memory',
    'mobile.agentChat.takeQueued': 'memory',
    'mobile.agentChat.runCommand': 'memory',
    'mobile.commanderInbox.reply': 'durable',
    'mobile.project.add': 'durable',
    'mobile.files.write': 'memory',
    'mobile.update.prepare': 'memory',
    'desktop.focus': 'durable',
    'desktop.openPath': 'durable',
    'desktop.openProject': 'durable',
    'desktop.openFile': 'durable',
    'files.reveal': 'durable',
    'files.openWithDefaultApp': 'durable',
    'project.openInEditor': 'durable',
    'project.openRoot': 'durable',
    'argv.update': 'memory',
    'gpu.restartInSafeMode': 'none',
    'gpu.testInjectContextLoss': 'none',
    'external.open': 'durable',
    'editor.confirmDiscard': 'durable',
    /**
     * Opens a native Save As dialog for one gesture; a replay would ask again where the user already answered.
     */
    'editor.saveUntitled': 'none',
    /**
     * Answers one quit-time question whose Main-side wait has its own timeout; a replay would answer nobody.
     */
    'editor.unsavedReply': 'none',
    /**
     * A menu choice answers one right-click gesture; replaying it after a reconnect would run an action the user can no
     * longer see the menu for.
     */
    'contextMenu.show': 'none',
    'processExplorer.open': 'durable',
    'benchmark.open': 'durable',
    /**
     * A toggle replayed after a reconnect would flip the window the user already settled.
     */
    'performanceMonitor.window': 'none',
    'benchmark.shareImage.copy': 'memory',
    'benchmark.shareImage.save': 'memory',
    'agentCommander.clearData': 'durable',
    'agentCommander.open': 'durable',
    'agentCommander.openFileLink': 'memory',
    'agentCommander.openSettings': 'durable',
    'agentCommander.revealSession': 'durable',
    'agentCommander.stop': 'durable',
    'dialog.selectDirectory': 'memory',
    'dialog.selectPaths': 'memory',
    'agentChat.confirmRevertFiles': 'memory',
    'agentChat.openPathReference': 'durable',
    'pathBrowser.start': 'memory',
    'pathBrowser.navigate': 'memory',
    'pathBrowser.open': 'memory',
    'pathBrowser.close': 'memory',
    'externalDocument.write': 'memory',
    'externalDocument.watch': 'memory',
    'externalDocument.reveal': 'durable',
    'externalDocument.openWithDefaultApp': 'durable',
    'externalDocument.openInTerminal': 'memory',
    'diagnostics.export': 'memory',
    'bugReport.captureScreenshot': 'memory',
    'bugReport.saveScreenshot': 'memory',
    'bugReport.send': 'durable',
    'updates.acknowledge': 'memory',
    'updates.download': 'memory',
    'updates.cancel': 'memory',
    'updates.open': 'memory',
    'shellCommand.install': 'memory',
    /**
     * Opening or reconnecting an SSH Host window is idempotent per destination; a replay only refocuses it.
     */
    'sshHost.connect': 'memory',
    'sshHost.reconnect': 'none',
    'sshHost.retryNow': 'none',
    'sshHost.cancel': 'none',
    'sshHost.sshConfig.reveal': 'none',
    'sshHost.stopServer': 'memory',
    /**
     * Answers one live OpenSSH prompt whose helper process waits with its own timeout; a replay would answer nobody.
     */
    'sshHost.askpass.reply': 'none',
    'shellCommand.uninstall': 'memory',
    'project.create': 'durable',
    'project.add': 'durable',
    'project.cancelCreate': 'durable',
    'project.delete': 'memory',
    'project.hide': 'durable',
    'project.reorder': 'durable',
    'project.setIcon': 'durable',
    'project.setChatDefault': 'durable',
    'session.create': 'durable',
    'session.delete': 'memory',
    'session.deleteMany': 'memory',
    'session.select': 'durable',
    'window.tearOffSession': 'memory',
    'window.reportViewing': 'memory',
    'session.markRead': 'durable',
    'session.refreshDeliveryOnFocus': 'memory',
    'session.reorder': 'durable',
    'session.reorderPinned': 'durable',
    'session.setPinned': 'durable',
    'session.rename': 'durable',
    'session.archive': 'durable',
    'session.compactWarm': 'memory',
    'session.conversationReference': 'memory',
    'session.importConversation': 'durable',
    'session.reopenConversation': 'durable',
    'session.unarchive': 'durable',
    'session.unarchiveMany': 'durable',
    'session.detach': 'durable',
    'session.resume': 'durable',
    'session.revokePermissionAutoAllow': 'memory',
    'session.updateState': 'memory',
    'terminal.create': 'durable',
    'terminal.input': 'none',
    'terminal.inputBinary': 'none',
    'terminal.inputAgentExact': 'none',
    'terminal.prepareLongPaste': 'memory',
    'terminal.resize': 'none',
    'terminal.close': 'durable',
    'terminal.attach': 'none',
    'terminal.detach': 'none',
    'terminal.moveToNewSession': 'durable',
    'terminal.restart': 'durable',
    'terminal.switchSurface': 'durable',
    'terminal.suspend': 'durable',
    'terminal.openFileLink': 'memory',
    'files.create': 'durable',
    'files.copy': 'durable',
    'files.rename': 'durable',
    'files.move': 'durable',
    'files.operation.cancel': 'durable',
    'files.operation.acknowledge': 'durable',
    'files.trash': 'durable',
    'files.write': 'memory',
    'git.switchBranch': 'durable',
    'git.sync': 'durable',
    'git.discard': 'durable',
    'git.mergePullRequest': 'durable',
    'gitReview.add': 'memory',
    'gitReview.edit': 'memory',
    'gitReview.remove': 'memory',
    'gitReview.refresh': 'memory',
    'gitReview.clearResolved': 'memory',
    'gitReview.send': 'memory',
    'settings.update': 'memory',
    'keybindings.update': 'memory',
    'theme.update': 'memory',
    'theme.import': 'memory',
} as const satisfies Record<EffectfulCaxriMethod, CommandRecovery>;

export type DurableCaxriMethod = {
    [M in EffectfulCaxriMethod]: (typeof effectfulCommandRecovery)[M] extends 'durable' ? M : never;
}[EffectfulCaxriMethod];

export function commandRecoveryFor(method: CaxriMethod): CommandRecovery {
    if (methods[method].effect === 'read') return 'none';
    return effectfulCommandRecovery[method as EffectfulCaxriMethod];
}

/**
 * Narrows a validated public request to the Main-owned portion of the method table.
 */
export function isDesktopRequest(request: CaxriRequest): request is DesktopRequest {
    return methods[request.method].owner === 'desktop';
}

/**
 * Narrows a validated public request to the Server-owned portion of the method table.
 */
export function isServerRequest(request: CaxriRequest): request is ServerRequest {
    return methods[request.method].owner === 'server';
}

/**
 * Compatibility guard used by the current Electron adapter.
 */
export function isMainRequest(request: CaxriRequest): request is MainRequest {
    return isDesktopRequest(request);
}

function isInternalMethod(value: string): value is InternalMethod {
    return Object.hasOwn(internalMethods, value);
}

export function getMethodSpec(method: string): MethodSpec | undefined {
    if (isCaxriMethod(method)) return methods[method];
    if (isInternalMethod(method)) return internalMethods[method];
    return undefined;
}

/**
 * True for a method that carries no mutation ordering, so it may settle concurrently instead of waiting its turn in a
 * connection's ordered admission lane.
 *
 * Lives here rather than beside either caller because both the Server's admission lane and the Desktop's
 * command-callback guard have to agree on it: the guard refuses a request precisely because it would queue behind the
 * command being serviced, which is only true for the requests this predicate excludes. An unknown method answers false,
 * so anything outside the registry is ordered.
 */
export function isConcurrentRead(method: string): boolean {
    return getMethodSpec(method)?.effect === 'read';
}

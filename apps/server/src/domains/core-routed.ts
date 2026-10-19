import type { ServerOperation } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { DomainOperation } from './domain-services';

/**
 * Rejects a Server-owned or internal method that Server Core answers itself (Host control, events, mobile access, Agent
 * endpoints, Extension Host views, Desktop routing) and therefore never forwards to a domain handler.
 */
export function coreRouted(method: ServerOperation): never {
    throw new CaxriError(
        'CONFLICT',
        `${method} is routed by Server Core and never reaches a domain handler`,
    );
}

/**
 * Core-answered methods that `DomainHandlers` still names because the protocol owner metadata cannot tell them apart
 * from domain-served Server methods. Desktop-owned methods are excluded from `DomainOperation` and need no entry here.
 * Listed here rather than as one handler line each in `create-domain-services.ts` to keep that file under its
 * physical-line budget.
 */
const CORE_ROUTED_METHODS = [
    'extensions.retry',
    'requests.cancel',
    'viewContainers.cancelRequest',
    'viewContainers.catalog',
    'viewContainers.executeCommand',
    'viewContainers.treeChildren',
    'viewContainers.viewOperation',
    'agent.context',
    'agent.list',
    'agent.grants',
    'agent.grant',
    'agent.revoke',
    'agent.delegation.access.create',
    'agent.delegation.access.list',
    'agent.delegation.access.revoke',
    'agent.session.rename',
    'agent.session.archive',
    'agent.session.unarchive',
    'agent.message.send',
    'agent.message.reply',
    'agent.message.wait',
    'agent.message.check',
    'agent.message.receipt',
    'agent.message.policy.get',
    'agent.message.policy.set',
    'agent.message.held',
    'agent.message.held.get',
    'agent.message.approve',
    'agent.message.deny',
    'events.recover',
    'events.query',
    'host.status',
    'host.stop',
    'mobile.access.status',
    'mobile.access.enable',
    'mobile.access.disable',
    'mobile.pairing.create',
    'mobile.device.list',
    'mobile.dashboard',
    'mobile.agent.actions',
    'mobile.session.archived',
    'mobile.session.rename',
    'mobile.session.archive',
    'mobile.session.restore',
    'mobile.session.setPinned',
    'mobile.terminal.takeOver',
    'mobile.terminal.release',
    'mobile.terminal.input',
    'mobile.terminal.scroll',
    'mobile.agentChat.read',
    'mobile.agentChat.readImage',
    'mobile.agentChat.readTask',
    'mobile.agentChat.readHistory',
    'mobile.agentChat.send',
    'mobile.agentChat.interrupt',
    'mobile.agentChat.stopTask',
    'mobile.agentChat.respond',
    'mobile.agentChat.retry',
    'mobile.agentChat.configure',
    'mobile.agentChat.removeQueued',
    'mobile.agentChat.sendQueuedNow',
    'mobile.agentChat.resumeQueue',
    'mobile.agentChat.takeQueued',
    'mobile.agentChat.runCommand',
    'mobile.commanderInbox.list',
    'mobile.commanderInbox.reply',
    'mobile.device.revoke.apply',
    'desktop.status',
    'desktop.focus',
    'desktop.openPath',
    'desktop.openProject',
    'desktop.openFile',
    'files.reveal',
    'files.openWithDefaultApp',
    'project.openInEditor',
    'project.openRoot',
    'project.query',
    'session.query',
    'terminal.query',
] as const satisfies readonly DomainOperation[];

export const coreRoutedHandlers = Object.fromEntries(
    CORE_ROUTED_METHODS.map((method) => [method, () => coreRouted(method)]),
) as Record<(typeof CORE_ROUTED_METHODS)[number], () => never>;

import type { ServerMethod } from '@caxri/protocol';

/**
 * Server-owned methods that Server Core answers itself, in `server-core.ts` or the Host, Agent endpoint, mobile access,
 * and Extension Host view routers, and never forwards to a domain service. Families that Core owns as a whole are
 * template-literal prefixes, so a new method inside one needs no edit here; every other method is listed by name.
 *
 * Everything else is `CoreForwardedMethod`, derived as the complement, so adding a domain-served registry method needs
 * no name list. A new Core-local method that is missing here (and from the `server-core.ts` switch) fails compilation
 * at the `default` branch instead of falling through to a `coreRouted()` domain stub.
 */
export type CoreHandledMethod = Extract<
    ServerMethod,
    | `agent.control.${string}`
    | `agent.dispatch.${string}`
    | `agent.message.${string}`
    | `agent.secret.${string}`
    | `agent.session.${string}`
    | `mobile.${string}`
    | `viewContainers.${string}`
    | 'agent.context'
    | 'agent.delegation.access.create'
    | 'agent.delegation.access.list'
    | 'agent.delegation.access.revoke'
    | 'agent.delegation.create'
    | 'agent.delegation.list'
    | 'agent.delegation.presets'
    | 'agent.delegation.result'
    | 'agent.delegation.status'
    | 'agent.delegation.stop'
    | 'agent.delegation.wait'
    | 'agent.grant'
    | 'agent.grants'
    | 'agent.list'
    | 'agent.revoke'
    | 'desktop.focus'
    | 'desktop.openFile'
    | 'desktop.openPath'
    | 'desktop.openProject'
    | 'desktop.status'
    | 'events.query'
    | 'events.recover'
    | 'extensions.retry'
    | 'files.openWithDefaultApp'
    | 'files.reveal'
    | 'host.status'
    | 'host.stop'
    | 'project.openInEditor'
    | 'project.openRoot'
    | 'project.query'
    | 'requests.cancel'
    | 'session.importConversation'
    | 'session.query'
    | 'terminal.preview'
    | 'terminal.query'
    | 'terminal.send'
>;
export type CoreForwardedMethod = Exclude<ServerMethod, CoreHandledMethod>;

import { isDelegationActive } from '@caxri/protocol';

import { coreRouted } from '../core-routed';
import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';
import type { AgentDelegationService } from './service';

type DelegationMethod =
    | 'agent.delegation.presets'
    | 'agent.delegation.presetsInternal'
    | 'agent.delegation.stop'
    | 'agent.delegation.stopInternal'
    | 'agent.delegation.create'
    | 'agent.delegation.status'
    | 'agent.delegation.result'
    | 'agent.delegation.list'
    | 'agent.delegation.listInternal'
    | 'agent.delegation.wait'
    | 'agent.delegation.waitInternal'
    | 'agent.delegation.createInternal'
    | 'agent.delegation.statusInternal'
    | 'agent.delegation.resultInternal';

/**
 * An answer returned to a caller counts as read, which makes its record evictable under capacity pressure. Background
 * collection goes through the service directly and never claims.
 */
function claimed<T extends { receipt: Parameters<typeof isDelegationActive>[0]; answer?: unknown }>(
    database: CaxriDatabase,
    read: T,
): T {
    if (read.answer && !isDelegationActive(read.receipt))
        database.agentDelegations.markCollected(read.receipt.delegationId, Date.now());
    return read;
}

export function createDelegationHandlers(
    service: AgentDelegationService,
    database: CaxriDatabase,
): Pick<DomainHandlers, DelegationMethod> {
    return {
        'agent.delegation.presets': () => coreRouted('agent.delegation.presets'),
        'agent.delegation.presetsInternal': ({
            projectId,
            sessionId,
            callerProvider,
            ...authority
        }) => service.presets(authority, { projectId, sessionId, callerProvider }),
        'agent.delegation.stop': () => coreRouted('agent.delegation.stop'),
        'agent.delegation.stopInternal': ({ delegationId, ...authority }) =>
            service.stop(delegationId, authority),
        'agent.delegation.create': () => coreRouted('agent.delegation.create'),
        'agent.delegation.status': () => coreRouted('agent.delegation.status'),
        'agent.delegation.result': () => coreRouted('agent.delegation.result'),
        'agent.delegation.list': () => coreRouted('agent.delegation.list'),
        'agent.delegation.listInternal': ({ active, limit, ...authority }) =>
            service.list(authority, { active, limit }),
        'agent.delegation.wait': () => coreRouted('agent.delegation.wait'),
        'agent.delegation.waitInternal': async (
            { delegationId, otherDelegationIds = [], timeoutMs, ...authority },
            signal,
        ) =>
            claimed(
                database,
                await service.wait(
                    [delegationId, ...otherDelegationIds],
                    authority,
                    timeoutMs,
                    signal,
                ),
            ),
        'agent.delegation.createInternal': ({ delegationId, input, ...authority }) =>
            service.create(delegationId, authority, input),
        'agent.delegation.statusInternal': ({ delegationId, ...authority }) =>
            service.status(delegationId, authority),
        'agent.delegation.resultInternal': async ({ delegationId, ...authority }) =>
            claimed(database, await service.result(delegationId, authority)),
    };
}

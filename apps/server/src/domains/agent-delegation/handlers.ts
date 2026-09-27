import type { DomainHandlers } from '../domain-services';
import { mainOwned } from '../service-handlers';
import type { AgentDelegationService } from './service';

type DelegationMethod =
    | 'agent.delegation.presets'
    | 'agent.delegation.presetsInternal'
    | 'agent.delegation.stop'
    | 'agent.delegation.stopInternal'
    | 'agent.delegation.create'
    | 'agent.delegation.status'
    | 'agent.delegation.result'
    | 'agent.delegation.wait'
    | 'agent.delegation.waitInternal'
    | 'agent.delegation.createInternal'
    | 'agent.delegation.statusInternal'
    | 'agent.delegation.resultInternal';

export function createDelegationHandlers(
    service: AgentDelegationService,
): Pick<DomainHandlers, DelegationMethod> {
    return {
        'agent.delegation.presets': () => mainOwned('agent.delegation.presets'),
        'agent.delegation.presetsInternal': ({
            projectId,
            sessionId,
            callerProvider,
            ...authority
        }) => service.presets(authority, { projectId, sessionId, callerProvider }),
        'agent.delegation.stop': () => mainOwned('agent.delegation.stop'),
        'agent.delegation.stopInternal': ({ delegationId, ...authority }) =>
            service.stop(delegationId, authority),
        'agent.delegation.create': () => mainOwned('agent.delegation.create'),
        'agent.delegation.status': () => mainOwned('agent.delegation.status'),
        'agent.delegation.result': () => mainOwned('agent.delegation.result'),
        'agent.delegation.wait': () => mainOwned('agent.delegation.wait'),
        'agent.delegation.waitInternal': (
            { delegationId, otherDelegationIds = [], timeoutMs, ...authority },
            signal,
        ) => service.wait([delegationId, ...otherDelegationIds], authority, timeoutMs, signal),
        'agent.delegation.createInternal': ({ delegationId, input, ...authority }) =>
            service.create(delegationId, authority, input),
        'agent.delegation.statusInternal': ({ delegationId, ...authority }) =>
            service.status(delegationId, authority),
        'agent.delegation.resultInternal': ({ delegationId, ...authority }) =>
            service.result(delegationId, authority),
    };
}

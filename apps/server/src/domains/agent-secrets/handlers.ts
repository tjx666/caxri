import type { DomainHandlers } from '../domain-services';
import type { AgentSecretService } from './service';

export function createAgentSecretHandlers(
    secrets: AgentSecretService,
): Pick<
    DomainHandlers,
    | 'secrets.list'
    | 'secrets.set'
    | 'secrets.delete'
    | 'secrets.requests.list'
    | 'secrets.requests.answer'
    | 'agent.secret.listInternal'
    | 'agent.secret.requestInternal'
    | 'agent.secret.waitInternal'
    | 'agent.secret.resolveInternal'
> {
    return {
        'secrets.list': async () => ({ secrets: await secrets.list() }),
        'secrets.set': ({ name, scope, value }) => secrets.set(name, scope, value),
        'secrets.delete': async ({ name, scope }) => ({
            deleted: await secrets.delete(name, scope),
        }),
        'secrets.requests.list': () => ({ requests: secrets.requests.pending() }),
        'secrets.requests.answer': (parameters) => secrets.answer(parameters),
        'agent.secret.listInternal': ({ caller }) => secrets.visible(caller),
        'agent.secret.requestInternal': (parameters) => secrets.request(parameters),
        'agent.secret.waitInternal': (parameters, signal) => secrets.wait(parameters, signal),
        'agent.secret.resolveInternal': (parameters) => secrets.resolve(parameters),
    };
}

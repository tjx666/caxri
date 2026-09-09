import type { AgentProvider } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { AgentDelegationAdapter } from './delegation-contract';
import { agentProviders } from './providers';

export function delegationAdapter(provider: AgentProvider): AgentDelegationAdapter {
    const adapter = agentProviders[provider].delegation;
    if (!adapter)
        throw new CaxriError('UNAVAILABLE', 'Provider does not support visible delegation');
    return adapter;
}

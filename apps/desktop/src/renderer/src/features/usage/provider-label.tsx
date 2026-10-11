import type { AgentProvider } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';

export function ProviderLabel({ provider }: { provider: AgentProvider }) {
    return (
        <span className="flex min-w-0 items-center gap-2">
            <AgentIdentityIcon identity={provider} size={14} />
            <span className="truncate">{agentProviderCatalog[provider].displayName}</span>
        </span>
    );
}

import type { AgentProvider } from '@caxri/protocol';

import { usePolledQuery } from '@/hooks/use-polled-query';

/**
 * Main caches each status page for a minute, so polling at the same pace keeps every surface on one shared reading and
 * costs at most one request per provider per minute while a surface is visible.
 */
const PROVIDER_STATUS_POLL_MS = 60_000;

/**
 * The provider's public service status, read through Main. `data` is null for a provider without a status page and
 * undefined while the first read is pending or when no provider is known yet.
 */
export function useAgentProviderStatus(provider: AgentProvider | undefined) {
    return usePolledQuery(
        'agentProviderStatus.read',
        // `enabled` keeps the placeholder from ever being sent.
        { provider: provider ?? 'claude' },
        {
            label: 'agentProviderStatus.read',
            intervalMs: PROVIDER_STATUS_POLL_MS,
            staleTime: PROVIDER_STATUS_POLL_MS / 2,
            retry: false,
            enabled: provider !== undefined,
        },
    );
}

import type { AgentProvider } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds, CaxriError } from '@caxri/protocol';

export interface AgentSkillProviderIntegration {
    configEnvironmentVariable: string;
    defaultConfigDirectory: string;
    localSkillsDirectory: string;
}

/**
 * Installing into provider-owned configuration is an explicit integration decision. A new catalog entry must declare a
 * reviewed layout here or use `null`; generic CLI enumeration must never infer one provider's paths for another.
 */
export const agentSkillProviderIntegrations: Record<
    AgentProvider,
    AgentSkillProviderIntegration | null
> = {
    claude: {
        configEnvironmentVariable: 'CLAUDE_CONFIG_DIR',
        defaultConfigDirectory: '.claude',
        localSkillsDirectory: '.claude',
    },
    codex: {
        configEnvironmentVariable: 'CODEX_HOME',
        defaultConfigDirectory: '.codex',
        localSkillsDirectory: '.agents',
    },
};

export const agentSkillProviderIds = agentProviderIds.filter(
    (provider) => agentSkillProviderIntegrations[provider] !== null,
);

export const agentSkillProviderUsage = agentSkillProviderIds.join('|');

export function requireAgentSkillProviderIntegration(
    provider: AgentProvider,
): AgentSkillProviderIntegration {
    const integration = agentSkillProviderIntegrations[provider];
    if (!integration)
        throw new CaxriError(
            'VALIDATION',
            `Caxri skill integration is unavailable for ${agentProviderCatalog[provider].displayName}`,
        );
    return integration;
}

export function parseAgentSkillProvider(source: string | undefined): AgentProvider {
    const provider = agentProviderIds.find((candidate) => candidate === source);
    if (!provider)
        throw new CaxriError(
            'VALIDATION',
            `--provider must be ${agentSkillProviderIds.join(' or ')}`,
        );
    requireAgentSkillProviderIntegration(provider);
    return provider;
}

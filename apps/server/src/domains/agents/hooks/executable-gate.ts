import type { AgentProvider, AgentProviderSettings } from '@caxri/protocol';
import { agentProviderIds } from '@caxri/protocol';

export type HookExecutableDiscovery = (
    provider: AgentProvider,
    executable: string,
) => Promise<string | undefined>;

/**
 * Treats an enabled provider whose CLI is missing as disabled for installation purposes.
 *
 * Lifecycle hooks default to enabled, but a provider whose CLI is not installed must not have Caxri write into its
 * configuration directory or claim it in the shared profile registry: the setting stays on, the installation simply
 * waits for the CLI to appear. The configured launch executable is honored so a renamed or wrapped CLI still counts.
 */
export async function gateHookSettingsOnExecutables(
    settings: Record<AgentProvider, AgentProviderSettings>,
    discoverExecutable: HookExecutableDiscovery,
): Promise<{
    effective: Record<AgentProvider, AgentProviderSettings>;
    missing: Set<AgentProvider>;
}> {
    const missing = new Set<AgentProvider>();
    const effective = { ...settings };
    await Promise.all(
        agentProviderIds.map(async (provider) => {
            if (!settings[provider].hooks.enabled) return;
            const executable = settings[provider].launch.executable;
            if ((await discoverExecutable(provider, executable)) !== undefined) return;
            missing.add(provider);
            effective[provider] = {
                ...settings[provider],
                hooks: { ...settings[provider].hooks, enabled: false },
            };
        }),
    );
    return { effective, missing };
}

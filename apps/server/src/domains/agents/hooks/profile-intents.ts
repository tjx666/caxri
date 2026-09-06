import { isAbsolute } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';
import { agentProviderIds } from '@caxri/protocol';

/**
 * Shared registry of which Caxri profiles want lifecycle hooks for which providers. Every instance sharing the bridge
 * root reads it under the install lock so one profile disabling a provider cannot uninstall hooks another still uses.
 */
const PROFILE_INTENTS_VERSION = 2;
const agentProviderIdSet = new Set<string>(agentProviderIds);

export interface ProfileHookIntentRegistry {
    profiles: Record<string, { profilePath: string; providers: AgentProvider[] }>;
    version: typeof PROFILE_INTENTS_VERSION;
}

export function parseProfileIntents(source: string | undefined): ProfileHookIntentRegistry {
    if (source === undefined) return { profiles: {}, version: PROFILE_INTENTS_VERSION };
    let value: unknown;
    try {
        value = JSON.parse(source) as unknown;
    } catch (error) {
        throw new Error('Caxri hook profile intents are not valid JSON', { cause: error });
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('Caxri hook profile intents are not an object');
    const record = value as Record<string, unknown>;
    if (record.version !== PROFILE_INTENTS_VERSION)
        throw new Error('Caxri hook profile intents use an unsupported version');
    if (typeof record.profiles !== 'object' || record.profiles === null)
        throw new Error('Caxri hook profile intents do not contain a profiles object');
    const profiles: ProfileHookIntentRegistry['profiles'] = {};
    for (const [profileId, candidate] of Object.entries(
        record.profiles as Record<string, unknown>,
    )) {
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
            throw new Error('Caxri hook profile intent is not an object');
        const providers = (candidate as Record<string, unknown>).providers;
        const profilePath = (candidate as Record<string, unknown>).profilePath;
        if (
            typeof profilePath !== 'string' ||
            !isAbsolute(profilePath) ||
            !Array.isArray(providers) ||
            !providers.every(
                (provider): provider is AgentProvider =>
                    typeof provider === 'string' && agentProviderIdSet.has(provider),
            )
        ) {
            throw new Error('Caxri hook profile intent contains an invalid path or provider');
        }
        profiles[profileId] = { profilePath, providers: [...new Set(providers)] };
    }
    return { profiles, version: PROFILE_INTENTS_VERSION };
}

export function serializeProfileIntents(registry: ProfileHookIntentRegistry): string {
    return `${JSON.stringify(
        {
            version: PROFILE_INTENTS_VERSION,
            profiles: Object.fromEntries(
                Object.entries(registry.profiles)
                    .toSorted(([left], [right]) => left.localeCompare(right))
                    .map(([profileId, intent]) => [
                        profileId,
                        {
                            profilePath: intent.profilePath,
                            providers: agentProviderIds.filter((provider) =>
                                intent.providers.includes(provider),
                            ),
                        },
                    ]),
            ),
        },
        null,
        2,
    )}\n`;
}

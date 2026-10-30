import { readBoundedRegularFileText } from '@caxri/system';

import type { AgentEnvironment } from '../../contract';
import { MAX_CLAUDE_GLOBAL_CONFIG_BYTES, resolveClaudeGlobalConfigPath } from './paths';

/**
 * The signed-in account's rate-limit tier as Claude Code last fetched it into its global config
 * (`oauthAccount.userRateLimitTier`, else `organizationRateLimitTier`), e.g. `default_claude_max_5x`. Claude Code's
 * `/usage` answer names only the subscription (`max`), and the tier is what tells Max 5x from Max 20x. Only this one
 * string is kept; undefined when the config is missing, unreadable, or names no tier (an API key or third-party
 * provider).
 */
export async function readClaudeRateLimitTier(
    environment: AgentEnvironment,
): Promise<string | undefined> {
    try {
        const config: unknown = JSON.parse(
            await readBoundedRegularFileText(
                await resolveClaudeGlobalConfigPath(environment),
                MAX_CLAUDE_GLOBAL_CONFIG_BYTES,
            ),
        );
        if (!isRecord(config) || !isRecord(config.oauthAccount)) return undefined;
        const { userRateLimitTier, organizationRateLimitTier } = config.oauthAccount;
        const tier = [userRateLimitTier, organizationRateLimitTier].find(
            (value): value is string => typeof value === 'string' && value.length > 0,
        );
        return tier?.slice(0, 64);
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

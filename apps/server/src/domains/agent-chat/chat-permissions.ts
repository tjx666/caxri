import type { AgentChatPermission, AgentChatPermissionMode, AgentProvider } from '@caxri/protocol';
import { agentChatPermissionModes, canAgentChatPlan } from '@caxri/protocol';

/**
 * Provider-neutral helpers for a Chat's permission level and plan mode. Each provider maps the levels to its own
 * settings, and back, in `<provider>-permissions.ts`. Caxri only offers levels a provider supports natively
 * (`agentChatPermissionCapabilities`); a launch setting no level matches reads as no level (the composer's "Custom").
 * See `docs/agent-chat.md`.
 */

/**
 * The stored choice a driver starts from, with a level the provider does not offer dropped so the launch settings
 * decide instead.
 */
export function supportedChatPermission(
    provider: AgentProvider,
    permission: AgentChatPermission | undefined,
): AgentChatPermission {
    const mode = permission?.permissionMode;
    return {
        ...(mode && agentChatPermissionModes(provider).includes(mode) && { permissionMode: mode }),
        planMode: canAgentChatPlan(provider) && permission?.planMode === true,
    };
}

/**
 * The snapshot state for the permission a provider runs with. `planMode` is present only where the provider has one.
 */
export function chatPermissionState(
    provider: AgentProvider,
    permissionMode: AgentChatPermissionMode | undefined,
    isPlanMode: boolean,
): { permissionMode: AgentChatPermissionMode | null; planMode?: boolean } {
    return {
        permissionMode: permissionMode ?? null,
        ...(canAgentChatPlan(provider) && { planMode: isPlanMode }),
    };
}

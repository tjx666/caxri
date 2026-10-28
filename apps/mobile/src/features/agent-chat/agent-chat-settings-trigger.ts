import type { AgentChatPermissionMode, AgentProvider } from '@caxri/protocol';

import type { AgentChatPermissionTrigger } from './agent-chat-permission-choice';

/**
 * The permission level a Chat starts with when nothing was changed, per provider: Codex's `Default` preset is its
 * accept-edits level, and Claude Code and Grok Build ask before anything that changes something.
 */
const defaultPermissionMode = (provider: AgentProvider): AgentChatPermissionMode =>
    provider === 'codex' ? 'acceptEdits' : 'ask';

/**
 * Whether the composer's settings row marks the permission level with its shield chip. The ordinary level stays quiet,
 * so the row carries only the model and effort; anything the reader would want to notice earns the glyph: a level other
 * than the provider's default (Full access most of all), plan mode, or launch settings that match no level (`mode`
 * absent).
 */
export const shouldMarkAgentChatPermission = ({
    mode,
    planMode,
    provider,
}: {
    mode: AgentChatPermissionMode | undefined;
    planMode: boolean;
    provider: AgentProvider;
}): boolean => planMode || mode !== defaultPermissionMode(provider);

/**
 * The permission trigger the settings row shows, or `undefined` when its chip stays hidden. The chip needs a trigger
 * and a known provider; it always shows when the model chip cannot (`hasModelTrigger` false), so permissions are never
 * unreachable, and otherwise only while `shouldMarkAgentChatPermission` says the level is worth noticing.
 */
export const visibleAgentChatPermissionTrigger = ({
    hasModelTrigger,
    mode,
    provider,
    trigger,
}: {
    hasModelTrigger: boolean;
    mode: AgentChatPermissionMode | undefined;
    provider: AgentProvider | undefined;
    trigger: AgentChatPermissionTrigger | undefined;
}): AgentChatPermissionTrigger | undefined => {
    if (!trigger || provider === undefined) return undefined;
    if (!hasModelTrigger) return trigger;
    return shouldMarkAgentChatPermission({ mode, planMode: trigger.isPlanMode, provider })
        ? trigger
        : undefined;
};

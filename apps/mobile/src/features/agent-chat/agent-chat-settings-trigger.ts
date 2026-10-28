import type { AgentChatPermissionMode, AgentProvider } from '@caxri/protocol';

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

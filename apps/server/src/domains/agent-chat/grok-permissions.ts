import type { AgentChatPermissionMode } from '@caxri/protocol';
import { agentChatPermissionModes } from '@caxri/protocol';

import { supportedChatPermission } from './chat-permissions';
import type { AgentChatSessionHost } from './chat-provider';
import type { GrokChatSettings } from './launch-settings';
import { grokChatSettings } from './launch-settings';

/**
 * Grok Build's permission levels as its launch arguments, and back. Grok Build fixes its permission at launch, so a
 * switch restarts the Agent with the new arguments. See `docs/agent-chat.md`.
 */

const GROK_ALWAYS_APPROVE = '--always-approve';
const GROK_PERMISSION_OPTION = '--permission-mode';

/**
 * Grok Build's root `--permission-mode` values that match a level, and `--always-approve` for Full access.
 */
const GROK_PERMISSION_MODES: Partial<Record<AgentChatPermissionMode, string>> = {
    ask: 'default',
    auto: 'auto',
};

function withoutOption(arguments_: readonly string[], option: string): string[] {
    const kept: string[] = [];
    for (let index = 0; index < arguments_.length; index += 1) {
        if (arguments_[index] === option) {
            index += 1;
            continue;
        }
        kept.push(arguments_[index]);
    }
    return kept;
}

/**
 * Replaces the permission options of Grok Build's launch arguments with `mode`'s.
 */
export function withGrokPermission(
    settings: GrokChatSettings,
    mode: AgentChatPermissionMode,
): GrokChatSettings {
    const rootArguments = withoutOption(settings.rootArgs, GROK_PERMISSION_OPTION);
    const agentArguments = settings.agentArgs.filter(
        (argument) => argument !== GROK_ALWAYS_APPROVE,
    );
    if (mode === 'fullAccess')
        return { rootArgs: rootArguments, agentArgs: [GROK_ALWAYS_APPROVE, ...agentArguments] };
    const value = GROK_PERMISSION_MODES[mode];
    if (!value) throw new Error(`Grok Build has no ${mode} permission`);
    return {
        rootArgs: [...rootArguments, GROK_PERMISSION_OPTION, value],
        agentArgs: agentArguments,
    };
}

/**
 * The `grok` arguments a Grok Build Chat opens with: the launch settings, with the Chat's chosen level in place of
 * their permission options, and the level that results.
 */
export function grokOpeningSettings(host: Pick<AgentChatSessionHost, 'launch' | 'permission'>): {
    settings: GrokChatSettings;
    permissionMode: AgentChatPermissionMode | undefined;
} {
    const launched = grokChatSettings(host.launch);
    const chosen = supportedChatPermission('grok', host.permission).permissionMode;
    const settings = chosen ? withGrokPermission(launched, chosen) : launched;
    return { settings, permissionMode: grokPermissionMode(settings) };
}

/**
 * The level Grok Build's launch arguments describe. Without `--permission-mode` Grok Build asks before acting.
 */
export function grokPermissionMode(
    settings: GrokChatSettings,
): AgentChatPermissionMode | undefined {
    if (settings.agentArgs.includes(GROK_ALWAYS_APPROVE)) return 'fullAccess';
    const index = settings.rootArgs.lastIndexOf(GROK_PERMISSION_OPTION);
    if (index === -1) return 'ask';
    const value = settings.rootArgs[index + 1];
    if (value === 'bypassPermissions') return 'fullAccess';
    return agentChatPermissionModes('grok').find((mode) => GROK_PERMISSION_MODES[mode] === value);
}

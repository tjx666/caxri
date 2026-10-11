import type { AgentChatPermission, AgentChatPermissionMode, AgentProvider } from '@caxri/protocol';
import { agentChatPermissionModes, canAgentChatPlan } from '@caxri/protocol';

import type { AgentChatSessionHost } from './chat-provider';
import type { CodexThreadSettings } from './codex-chat-types';
import type { ClaudeChatSettings, GrokChatSettings } from './launch-settings';
import { grokChatSettings } from './launch-settings';

/**
 * Maps each provider-neutral permission level to the provider's own setting, and back. Caxri only offers levels a
 * provider supports natively (`agentChatPermissionCapabilities`); a launch setting no level matches reads as no level
 * (the composer's "Custom"). See `docs/agent-chat.md`.
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

export type CodexPermissionSettings = Pick<
    CodexThreadSettings,
    'approvalPolicy' | 'approvalsReviewer' | 'sandbox'
>;

/**
 * Codex's presets: Read Only, Default, Approve for me (approval requests go to Codex's auto-review agent), and Full
 * Access. Read Only keeps `on-request` so Codex can still ask to go beyond the sandbox.
 */
const CODEX_PERMISSIONS: Partial<Record<AgentChatPermissionMode, CodexPermissionSettings>> = {
    readOnly: { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' },
    acceptEdits: {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
    },
    auto: {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandbox: 'workspace-write',
    },
    fullAccess: {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'danger-full-access',
    },
};

export function codexPermissionSettings(mode: AgentChatPermissionMode): CodexPermissionSettings {
    const settings = CODEX_PERMISSIONS[mode];
    if (!settings) throw new Error(`Codex has no ${mode} permission`);
    return settings;
}

/**
 * The level that matches Codex's thread settings, if any.
 */
export function codexPermissionMode(
    settings: CodexPermissionSettings,
): AgentChatPermissionMode | undefined {
    return agentChatPermissionModes('codex').find((mode) => {
        const candidate = CODEX_PERMISSIONS[mode];
        return (
            candidate?.approvalPolicy === settings.approvalPolicy &&
            candidate.approvalsReviewer === settings.approvalsReviewer &&
            candidate.sandbox === settings.sandbox
        );
    });
}

/**
 * `turn/start` takes the sandbox as a policy object rather than `thread/start`'s mode name. Only the type is sent, so
 * Codex fills in its own defaults for that sandbox.
 */
export function codexSandboxPolicy(sandbox: CodexThreadSettings['sandbox']): { type: string } {
    switch (sandbox) {
        case 'read-only': {
            return { type: 'readOnly' };
        }
        case 'workspace-write': {
            return { type: 'workspaceWrite' };
        }
        case 'danger-full-access': {
            return { type: 'dangerFullAccess' };
        }
    }
}

type ClaudePermissionMode = ClaudeChatSettings['permissionMode'];

const CLAUDE_PERMISSIONS: Partial<Record<AgentChatPermissionMode, ClaudePermissionMode>> = {
    ask: 'default',
    acceptEdits: 'acceptEdits',
    auto: 'auto',
    fullAccess: 'bypassPermissions',
};

/**
 * The Agent SDK permission mode for a choice: `plan` while plan mode is on, the chosen level otherwise, and the launch
 * settings' mode without a chosen level.
 */
export function claudePermissionMode(
    permission: AgentChatPermission,
    launchMode: ClaudePermissionMode,
): ClaudePermissionMode {
    if (permission.planMode) return 'plan';
    const mode = permission.permissionMode && CLAUDE_PERMISSIONS[permission.permissionMode];
    if (mode) return mode;
    // A launch `--permission-mode plan` is not carried over: plan mode is the composer's toggle.
    return launchMode === 'plan' ? 'default' : launchMode;
}

/**
 * The level and plan mode an Agent SDK permission mode stands for. `dontAsk` matches no level.
 */
export function claudeChatPermission(mode: string): {
    permissionMode?: AgentChatPermissionMode;
    planMode: boolean;
} {
    if (mode === 'plan') return { planMode: true };
    const level = agentChatPermissionModes('claude').find(
        (candidate) => CLAUDE_PERMISSIONS[candidate] === mode,
    );
    return { ...(level && { permissionMode: level }), planMode: false };
}

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

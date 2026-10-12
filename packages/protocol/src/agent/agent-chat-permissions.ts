import { z } from 'zod';

import { CaxriError } from '../transport/errors.js';
import type { AgentProvider } from './agents.js';
import { agentProviderIds } from './agents.js';

/**
 * How freely an Agent Chat's provider may act without asking, as one provider-neutral level. Each provider offers only
 * the levels it supports natively ({@link agentChatPermissionModes}); Caxri never emulates a level a provider lacks.
 *
 * - `readOnly`: the provider may read but not change files (Codex's read-only sandbox).
 * - `ask`: every tool that changes something asks first.
 * - `acceptEdits`: file edits in the workspace run without asking; anything else still asks.
 * - `auto`: the provider's own reviewer decides which actions need the user.
 * - `fullAccess`: nothing asks and nothing is sandboxed.
 */
export const agentChatPermissionModeIds = [
    'readOnly',
    'ask',
    'acceptEdits',
    'auto',
    'fullAccess',
] as const;

export const agentChatPermissionModeSchema = z.enum(agentChatPermissionModeIds);

export type AgentChatPermissionMode = z.infer<typeof agentChatPermissionModeSchema>;

/**
 * What one provider offers in the permission menu: its levels, least permissive first, and whether it has a native plan
 * mode. See `docs/agent-chat.md` for the native setting each level maps to.
 */
export interface AgentChatPermissionCapabilities {
    modes: readonly AgentChatPermissionMode[];
    planMode: boolean;
    /**
     * Whether a switch made while a turn runs reaches the provider only with the next turn. The Chat reports the new
     * choice at once, so a Client says when it takes effect instead of implying the running turn already uses it.
     */
    appliesOnNextTurn: boolean;
}

export const agentChatPermissionCapabilities = {
    /**
     * Claude Code's `--permission-mode` values; `plan` is its own mode, so plan mode replaces the level until it ends.
     * `dontAsk` (deny anything not pre-approved) is not offered: it only differs from `ask` with allow rules.
     */
    claude: {
        modes: ['ask', 'acceptEdits', 'auto', 'fullAccess'],
        planMode: true,
        appliesOnNextTurn: false,
    },
    /**
     * Codex's sandbox and approval presets: Read Only, Default, Approve for me (auto-review), and Full Access. Plan
     * mode is app-server's `collaborationMode`. Both have no in-place request and ride on the next `turn/start`.
     */
    codex: {
        modes: ['readOnly', 'acceptEdits', 'auto', 'fullAccess'],
        planMode: true,
        appliesOnNextTurn: true,
    },
    /**
     * Grok Build's `--permission-mode default|auto` and `--always-approve`. It has no accept-edits mode, and its plan
     * mode needs ACP extensions Caxri does not handle yet. A switch restarts it and is refused while a turn runs.
     */
    grok: { modes: ['ask', 'auto', 'fullAccess'], planMode: false, appliesOnNextTurn: false },
} as const satisfies Record<AgentProvider, AgentChatPermissionCapabilities>;

/**
 * The levels `provider` offers, least permissive first.
 */
export function agentChatPermissionModes(
    provider: AgentProvider,
): readonly AgentChatPermissionMode[] {
    return agentChatPermissionCapabilities[provider].modes;
}

export function canAgentChatPlan(provider: AgentProvider): boolean {
    return agentChatPermissionCapabilities[provider].planMode;
}

/**
 * Whether `provider` applies a permission or plan mode switch made during a running turn only from the next turn.
 */
export function isAgentChatPermissionNextTurnOnly(provider: AgentProvider): boolean {
    return agentChatPermissionCapabilities[provider].appliesOnNextTurn;
}

/**
 * A Chat's permission choice. An absent `permissionMode` follows the provider's launch settings.
 */
export interface AgentChatPermission {
    permissionMode?: AgentChatPermissionMode;
    planMode: boolean;
}

/**
 * The permission a new Chat of one provider starts with, set from a Chat's "Set as Project default".
 */
export const agentChatDefaultSchema = z.strictObject({
    permissionMode: agentChatPermissionModeSchema.optional(),
    planMode: z.boolean().optional(),
});

export type AgentChatDefault = z.infer<typeof agentChatDefaultSchema>;

/**
 * A Project's Chat defaults, per provider, because each provider offers different levels.
 */
export const projectChatDefaultsSchema = z.partialRecord(
    z.enum(agentProviderIds),
    agentChatDefaultSchema,
);

export type ProjectChatDefaults = z.infer<typeof projectChatDefaultsSchema>;

/**
 * The choice a new `provider` Chat starts from: the Project default, with a level or plan mode the provider does not
 * offer dropped so the launch settings decide instead.
 */
export function initialAgentChatPermission(
    provider: AgentProvider,
    defaults: ProjectChatDefaults | undefined,
): AgentChatPermission {
    const entry = defaults?.[provider];
    const mode = entry?.permissionMode;
    return {
        ...(mode && agentChatPermissionModes(provider).includes(mode) && { permissionMode: mode }),
        planMode: canAgentChatPlan(provider) && entry?.planMode === true,
    };
}

/**
 * A permission switch as a Client asks for it.
 */
export interface AgentChatPermissionRequest {
    permissionMode?: AgentChatPermissionMode;
    planMode?: boolean;
}

/**
 * Validates a switch against what the provider offers and merges it into the current choice. Fails with `VALIDATION`
 * for a level or plan mode the provider does not offer.
 */
export function resolveAgentChatPermissionChange(
    provider: AgentProvider,
    current: AgentChatPermission,
    change: AgentChatPermissionRequest,
): AgentChatPermission {
    if (
        change.permissionMode !== undefined &&
        !agentChatPermissionModes(provider).includes(change.permissionMode)
    )
        throw new CaxriError(
            'VALIDATION',
            `${agentChatPermissionModeLabel(change.permissionMode)} is not available in this Chat`,
        );
    if (change.planMode === true && !canAgentChatPlan(provider))
        throw new CaxriError('VALIDATION', 'Plan mode is not available in this Chat');
    const permissionMode = change.permissionMode ?? current.permissionMode;
    return {
        ...(permissionMode && { permissionMode }),
        planMode: change.planMode ?? current.planMode,
    };
}

const PERMISSION_MODE_LABELS: Record<AgentChatPermissionMode, string> = {
    readOnly: 'Read only',
    ask: 'Ask for approval',
    acceptEdits: 'Accept edits',
    auto: 'Auto',
    fullAccess: 'Full access',
};

/**
 * Codex names its workspace-write preset "Default"; keeping its own word avoids implying Codex asks before every edit.
 */
const PROVIDER_LABELS: Partial<
    Record<AgentProvider, Partial<Record<AgentChatPermissionMode, string>>>
> = {
    codex: { acceptEdits: 'Default' },
};

/**
 * The menu and trigger name of one level, in the provider's own words where it has them.
 */
export function agentChatPermissionModeLabel(
    mode: AgentChatPermissionMode,
    provider?: AgentProvider,
): string {
    return (provider && PROVIDER_LABELS[provider]?.[mode]) ?? PERMISSION_MODE_LABELS[mode];
}

const PERMISSION_MODE_DESCRIPTIONS: Record<
    AgentProvider,
    Partial<Record<AgentChatPermissionMode, string>>
> = {
    claude: {
        ask: 'Asks before edits and commands',
        acceptEdits: 'Edits files without asking',
        auto: 'A classifier approves safe actions',
        fullAccess: 'Runs every tool without asking',
    },
    codex: {
        readOnly: 'Reads files; asks before any change',
        acceptEdits: 'Edits in the workspace; asks to go further',
        auto: 'A reviewer agent handles approvals',
        fullAccess: 'No sandbox and no approvals',
    },
    grok: {
        ask: 'Asks before edits and commands',
        auto: 'A classifier approves safe actions',
        fullAccess: 'Runs every tool without asking',
    },
};

/**
 * One line under a level in the menu, saying what it means for this provider.
 */
export function agentChatPermissionModeDescription(
    provider: AgentProvider,
    mode: AgentChatPermissionMode,
): string | undefined {
    return PERMISSION_MODE_DESCRIPTIONS[provider][mode];
}

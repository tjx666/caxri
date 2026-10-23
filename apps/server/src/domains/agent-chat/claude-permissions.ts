import type { AgentChatPermission, AgentChatPermissionMode } from '@caxri/protocol';
import { agentChatPermissionModes } from '@caxri/protocol';

import { chatPermissionState, supportedChatPermission } from './chat-permissions';
import type { AgentChatSessionHost } from './chat-provider';
import type { ClaudeChatSettings } from './launch-settings';

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

/**
 * The part of the Agent SDK `Query` that switches the permission mode in place.
 */
interface PermissionModeSwitch {
    setPermissionMode(mode: ClaudePermissionMode): Promise<void>;
}

/**
 * One Claude Chat's permission level and plan mode. Claude Code switches its permission mode in place
 * (`Query.setPermissionMode`), so a switch applies from the next tool call on, and plan mode is its `plan` mode. The
 * level and plan mode are kept apart because Claude Code has one mode for both: leaving plan mode returns to the chosen
 * level rather than to whatever mode Claude Code picks after an approved plan.
 */
export class ClaudePermissions {
    private level: AgentChatPermissionMode | undefined;

    private planMode: boolean;

    /**
     * The mode Claude Code starts with.
     */
    readonly startMode: ClaudePermissionMode;

    constructor(
        private readonly host: Pick<
            AgentChatSessionHost,
            'apply' | 'onPermissionChanged' | 'permission'
        >,
        private readonly launchMode: ClaudePermissionMode,
    ) {
        const chosen = supportedChatPermission('claude', host.permission);
        this.planMode = chosen.planMode;
        this.level =
            chosen.permissionMode ??
            claudeChatPermission(claudePermissionMode({ planMode: false }, launchMode))
                .permissionMode;
        this.startMode = claudePermissionMode(this.current(), launchMode);
    }

    private current(): AgentChatPermission {
        return { ...(this.level && { permissionMode: this.level }), planMode: this.planMode };
    }

    /**
     * The mode an approved plan returns to: the chosen level, so the approval switches to it in the same step. Without
     * a chosen level, or outside plan mode, Claude Code picks.
     */
    planExitMode(): ClaudePermissionMode | undefined {
        if (!this.planMode || !this.level) return undefined;
        return claudePermissionMode(
            { permissionMode: this.level, planMode: false },
            this.launchMode,
        );
    }

    report(): void {
        this.host.apply([
            { op: 'state', state: chatPermissionState('claude', this.level, this.planMode) },
        ]);
    }

    /**
     * Switches Claude Code in place and shows the result once it accepted.
     */
    async set(query: PermissionModeSwitch, permission: AgentChatPermission): Promise<void> {
        const level = permission.permissionMode ?? this.level;
        await query.setPermissionMode(
            claudePermissionMode(
                { ...(level && { permissionMode: level }), planMode: permission.planMode },
                this.launchMode,
            ),
        );
        this.level = level;
        this.planMode = permission.planMode;
        this.report();
    }

    /**
     * Follows the mode Claude Code reports with each turn's `init` and with `status` changes. Leaving plan mode on its
     * own (an approved plan) turns plan mode off; the approval already switched to the chosen level (see
     * `planExitMode`), and a mode that still differs is switched back as a fallback. The change is saved as the
     * Chat's.
     */
    onReported(reported: unknown, query: PermissionModeSwitch | undefined): void {
        if (typeof reported !== 'string') return;
        const { permissionMode, planMode } = claudeChatPermission(reported);
        if (planMode) {
            if (this.planMode) return;
            this.planMode = true;
        } else if (this.planMode) {
            this.planMode = false;
            const target = this.level && claudePermissionMode(this.current(), this.launchMode);
            if (!target || target === reported) this.level = permissionMode;
            else if (query) void query.setPermissionMode(target).catch(() => {});
        } else {
            if (permissionMode === this.level) return;
            this.level = permissionMode;
        }
        this.report();
        this.host.onPermissionChanged(this.current());
    }
}

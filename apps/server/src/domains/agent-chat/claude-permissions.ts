import type { AgentChatPermission, AgentChatPermissionMode } from '@caxri/protocol';

import {
    chatPermissionState,
    claudeChatPermission,
    claudePermissionMode,
    supportedChatPermission,
} from './chat-permissions';
import type { AgentChatSessionHost } from './chat-provider';
import type { ClaudeChatSettings } from './launch-settings';

type ClaudePermissionMode = ClaudeChatSettings['permissionMode'];

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
     * own (an approved plan) turns plan mode off and returns to the chosen level; the change is saved as the Chat's.
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
            // eslint-disable-next-line no-void -- best effort: a refused switch leaves the mode Claude Code reported
            else if (query) void query.setPermissionMode(target).catch(() => {});
        } else {
            if (permissionMode === this.level) return;
            this.level = permissionMode;
        }
        this.report();
        this.host.onPermissionChanged(this.current());
    }
}

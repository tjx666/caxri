import type { AgentChatPermission, AgentChatPermissionMode } from '@caxri/protocol';
import { agentChatPermissionModes } from '@caxri/protocol';

import { chatPermissionState, supportedChatPermission } from '../../chat-permissions';
import type { AgentChatSessionHost } from '../../chat-provider';
import type { ClaudeChatSettings } from '../../launch-settings';

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
     * Switches (`set`) whose native result is not yet confirmed.
     */
    private unconfirmed = 0;

    /**
     * The native mode a plan-exit correction is switching Claude Code to, until Claude Code confirms or refuses it.
     */
    private correction: ClaudePermissionMode | undefined;

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
     * Switches Claude Code back to the chosen level after an approved plan left it in another mode. Until Claude Code
     * confirms, the Chat is unapplied (`appliedPermission`). A refusal converges to the mode Claude Code is really in,
     * so a failed correction never leaves the chosen level standing for a mode that does not run. Without a `query`
     * there is nothing to switch, and the caller converges at once.
     */
    private correct(
        query: PermissionModeSwitch,
        target: ClaudePermissionMode,
        native: AgentChatPermissionMode | undefined,
    ): void {
        this.correction = target;
        const settle = () => {
            if (this.correction === target) this.correction = undefined;
        };
        void (async () => {
            try {
                await query.setPermissionMode(target);
                settle();
            } catch {
                if (this.correction !== target) return;
                this.correction = undefined;
                this.level = native;
                this.report();
                this.host.onPermissionChanged(this.current());
            }
        })();
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

    /**
     * What this Chat runs under now, and whether that is confirmed. `applied` is false while a switch or a plan-exit
     * correction is still in flight: Claude Code may then still run the previous native mode, so the chosen level is
     * not yet what authorizes tool calls. A delegating Agent's approval power reads this, never the chosen level
     * alone.
     */
    appliedPermission(): {
        permissionMode?: AgentChatPermissionMode;
        planMode: boolean;
        applied: boolean;
    } {
        return {
            ...this.current(),
            applied: this.unconfirmed === 0 && this.correction === undefined,
        };
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
        this.unconfirmed += 1;
        try {
            await query.setPermissionMode(
                claudePermissionMode(
                    { ...(level && { permissionMode: level }), planMode: permission.planMode },
                    this.launchMode,
                ),
            );
        } finally {
            this.unconfirmed -= 1;
        }
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
            if (!target || target === reported || !query) this.level = permissionMode;
            else this.correct(query, target, permissionMode);
        } else {
            if (this.correction === reported) this.correction = undefined;
            if (permissionMode === this.level) return;
            this.level = permissionMode;
        }
        this.report();
        this.host.onPermissionChanged(this.current());
    }
}

import type {
    AgentChatDefault,
    AgentChatSnapshot,
    AgentProvider,
    ProjectChatDefaults,
} from '@caxri/protocol';
import { agentChatPermissionModeLabel } from '@caxri/protocol';

/**
 * The composer's permission trigger: the level's name, or "Custom" for launch settings no level matches.
 */
export function agentChatPermissionLabel(
    snapshot: Pick<AgentChatSnapshot, 'permissionMode'>,
    provider: AgentProvider,
): string {
    return snapshot.permissionMode
        ? agentChatPermissionModeLabel(snapshot.permissionMode, provider)
        : 'Custom';
}

/**
 * The Project default "Use as Project default" would save: the Chat's level and, where the provider has one, its plan
 * mode. `undefined` while the level is "Custom", since a default must name a level.
 */
export function agentChatProjectDefault(
    snapshot: Pick<AgentChatSnapshot, 'permissionMode' | 'planMode'>,
): AgentChatDefault | undefined {
    if (!snapshot.permissionMode) return undefined;
    return {
        permissionMode: snapshot.permissionMode,
        ...(snapshot.planMode !== undefined && { planMode: snapshot.planMode }),
    };
}

/**
 * Whether the Project's saved default for `provider` already is `chatDefault`, so saving it again would change nothing.
 */
export function isAgentChatProjectDefault(
    chatDefault: AgentChatDefault,
    defaults: ProjectChatDefaults | undefined,
    provider: AgentProvider,
): boolean {
    const saved = defaults?.[provider];
    return (
        saved !== undefined &&
        saved.permissionMode === chatDefault.permissionMode &&
        (saved.planMode ?? false) === (chatDefault.planMode ?? false)
    );
}

/**
 * What the composer's permission trigger and its menu show for one Chat.
 */
export interface AgentChatPermissionView {
    /**
     * The level's name in the provider's words, or "Custom".
     */
    label: string;
    /**
     * The trigger's accessible name, which also says when plan mode is on.
     */
    ariaLabel: string;
    /**
     * Full access gets a warning shield so the riskiest level reads differently at a glance.
     */
    isFullAccess: boolean;
    /**
     * What "Use as Project default" would save; `undefined` while the level is "Custom".
     */
    projectDefault: AgentChatDefault | undefined;
    /**
     * Whether the Project already has this default, so the menu shows it as saved instead.
     */
    isSavedDefault: boolean;
}

/**
 * Derives everything the permission trigger and menu render, so the component stays wiring only.
 */
export function agentChatPermissionView(
    snapshot: Pick<AgentChatSnapshot, 'permissionMode' | 'planMode'>,
    provider: AgentProvider,
    defaults: ProjectChatDefaults | undefined,
): AgentChatPermissionView {
    const label = agentChatPermissionLabel(snapshot, provider);
    const projectDefault = agentChatProjectDefault(snapshot);
    return {
        label,
        ariaLabel: `Permissions: ${label}${snapshot.planMode ? ', plan mode on' : ''}`,
        isFullAccess: snapshot.permissionMode === 'fullAccess',
        projectDefault,
        isSavedDefault:
            projectDefault !== undefined &&
            isAgentChatProjectDefault(projectDefault, defaults, provider),
    };
}

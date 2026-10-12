import type {
    AgentChatDefault,
    AgentChatPermissionMode,
    AgentChatPermissionRequest,
    AgentChatSnapshot,
    AgentProvider,
    ProjectChatDefaults,
} from '@caxri/protocol';
import { agentChatPermissionModeDescription } from '@caxri/protocol';

import { isTranslationKey, translate } from '../../i18n';

/**
 * The menu and trigger name of one level, translated. Codex names its workspace-write preset "Default"
 * (`agentChatPermissionModeLabel`), which keeps its own key.
 */
export function agentChatPermissionModeName(
    mode: AgentChatPermissionMode,
    provider?: AgentProvider,
): string {
    if (provider === 'codex' && mode === 'acceptEdits')
        return translate('agentChat.permission.mode.codexDefault');
    return translate(`agentChat.permission.mode.${mode}`);
}

/**
 * One line under a level in the menu, translated where the key exists and otherwise the protocol's English line.
 */
export function agentChatPermissionModeHint(
    provider: AgentProvider,
    mode: AgentChatPermissionMode,
): string | undefined {
    const key = `agentChat.permission.description.${provider}.${mode}`;
    return isTranslationKey(key)
        ? translate(key)
        : agentChatPermissionModeDescription(provider, mode);
}

/**
 * The composer's permission trigger: the level's name, or "Custom" for launch settings no level matches.
 */
export function agentChatPermissionLabel(
    snapshot: Pick<AgentChatSnapshot, 'permissionMode'>,
    provider: AgentProvider,
): string {
    return snapshot.permissionMode
        ? agentChatPermissionModeName(snapshot.permissionMode, provider)
        : translate('agentChat.permission.custom');
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
 * The "Use as Project default" row: what it reads, whether it shows as checked (the Chat already matches the saved
 * default), and why it is unavailable when it is.
 */
export interface AgentChatProjectDefaultItem {
    label: string;
    isChecked: boolean;
    /**
     * Shown under the row while it is disabled, so the action reads as unavailable rather than missing.
     */
    disabledReason?: string;
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
     * The trigger's accessible name, which also says when the choice waits for the next turn.
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
    projectDefaultItem: AgentChatProjectDefaultItem;
    /**
     * The trigger's muted suffix while the shown choice reaches the provider only with the next turn.
     */
    pendingCaption: string | undefined;
}

/**
 * The menu row a Chat whose launch settings match no level shows checked, so "Custom" in the trigger has a row that
 * explains it. Choosing it changes nothing: Caxri cannot put launch settings back once a level replaced them. The row's
 * text lives under `agentChat.permission.customRow*`.
 */
export const AGENT_CHAT_CUSTOM_PERMISSION = {
    value: 'custom',
} as const;

function projectDefaultItem(
    projectDefault: AgentChatDefault | undefined,
    isSavedDefault: boolean,
): AgentChatProjectDefaultItem {
    if (!projectDefault)
        return {
            label: translate('agentChat.permission.useAsProjectDefault'),
            isChecked: false,
            disabledReason: translate('agentChat.permission.chooseLevelForDefault'),
        };
    return isSavedDefault
        ? { label: translate('agentChat.permission.projectDefault'), isChecked: true }
        : { label: translate('agentChat.permission.useAsProjectDefault'), isChecked: false };
}

/**
 * Derives everything the permission trigger and menu render, so the component stays wiring only. `isDeferred` says the
 * shown choice waits for the next turn (`isAgentChatPermissionDeferred`).
 */
export function agentChatPermissionView(
    snapshot: Pick<AgentChatSnapshot, 'permissionMode' | 'planMode'>,
    provider: AgentProvider,
    defaults: ProjectChatDefaults | undefined,
    { isDeferred = false }: { isDeferred?: boolean } = {},
): AgentChatPermissionView {
    const label = agentChatPermissionLabel(snapshot, provider);
    const projectDefault = agentChatProjectDefault(snapshot);
    const isSavedDefault =
        projectDefault !== undefined &&
        isAgentChatProjectDefault(projectDefault, defaults, provider);
    return {
        label,
        ariaLabel: `${translate('agentChat.permission.triggerLabel', { label })}${isDeferred ? translate('agentChat.permission.triggerDeferred') : ''}`,
        isFullAccess: snapshot.permissionMode === 'fullAccess',
        projectDefault,
        isSavedDefault,
        projectDefaultItem: projectDefaultItem(projectDefault, isSavedDefault),
        pendingCaption: isDeferred ? translate('agentChat.permission.pendingCaption') : undefined,
    };
}

type PermissionSnapshot = Pick<AgentChatSnapshot, 'permissionMode' | 'planMode'>;

/**
 * A permission switch the picker already shows while Server Core and the provider apply it, mirroring the model
 * picker's `AgentChatPendingSelection`: the choice shows at once, and a failed switch drops it again.
 */
export interface AgentChatPendingPermission {
    change: AgentChatPermissionRequest;
    /**
     * The level and plan mode the snapshot reported when the switch was requested.
     */
    baseline: {
        permissionMode: AgentChatPermissionMode | undefined;
        planMode: boolean | undefined;
    };
    /**
     * Server Core accepted the switch, so any change in the reported choice is its answer.
     */
    isAccepted: boolean;
}

/**
 * Whether the snapshot now answers the pending switch: it reports the requested level and plan mode, or, once the
 * switch was accepted, it changed from the baseline at all.
 */
export function isAgentChatPermissionSettled(
    pending: AgentChatPendingPermission,
    snapshot: PermissionSnapshot | undefined,
): boolean {
    const { change, baseline } = pending;
    const isLevelConfirmed =
        change.permissionMode === undefined || snapshot?.permissionMode === change.permissionMode;
    const isPlanConfirmed =
        change.planMode === undefined || (snapshot?.planMode ?? false) === change.planMode;
    if (isLevelConfirmed && isPlanConfirmed) return true;
    return (
        pending.isAccepted &&
        (snapshot?.permissionMode !== baseline.permissionMode ||
            snapshot?.planMode !== baseline.planMode)
    );
}

/**
 * The snapshot as the picker shows it while a switch is pending.
 */
export function agentChatPermissionSelectionView<Snapshot extends PermissionSnapshot>(
    snapshot: Snapshot,
    pending: AgentChatPendingPermission | undefined,
): Snapshot {
    if (!pending) return snapshot;
    const permissionMode = pending.change.permissionMode ?? snapshot.permissionMode;
    const planMode = pending.change.planMode ?? snapshot.planMode;
    return {
        ...snapshot,
        ...(permissionMode && { permissionMode }),
        ...(planMode !== undefined && { planMode }),
    };
}

/**
 * The level and plan mode the running turn started with, captured when the user first switches during that turn, so the
 * picker can tell a choice still waiting for the next turn from one already in force.
 */
export interface AgentChatPermissionTurnBaseline {
    turnId: string;
    permissionMode: AgentChatPermissionMode | undefined;
    planMode: boolean;
}

/**
 * The baseline to keep after a switch requested now: the running turn's existing one, a fresh capture of what the turn
 * runs with, or none when no turn runs or the provider applies switches in place.
 */
export function nextAgentChatPermissionTurnBaseline(
    current: AgentChatPermissionTurnBaseline | undefined,
    state: {
        activeTurnId: string | undefined;
        appliesOnNextTurn: boolean;
        reported: PermissionSnapshot;
    },
): AgentChatPermissionTurnBaseline | undefined {
    if (!state.appliesOnNextTurn || !state.activeTurnId) return undefined;
    if (current?.turnId === state.activeTurnId) return current;
    return {
        turnId: state.activeTurnId,
        permissionMode: state.reported.permissionMode,
        planMode: state.reported.planMode ?? false,
    };
}

/**
 * Whether the shown choice differs from what the running turn uses, so it applies only from the next turn. A baseline
 * from an earlier turn no longer counts: that turn ended and the next one picked the choice up.
 */
export function isAgentChatPermissionDeferred(
    baseline: AgentChatPermissionTurnBaseline | undefined,
    shown: PermissionSnapshot,
    activeTurnId: string | undefined,
): boolean {
    if (!baseline || baseline.turnId !== activeTurnId) return false;
    return (
        shown.permissionMode !== baseline.permissionMode ||
        (shown.planMode ?? false) !== baseline.planMode
    );
}

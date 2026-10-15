import type {
    AgentChatPermissionMode,
    AgentChatPermissionRequest,
    AgentChatSnapshot,
    AgentProvider,
} from '@caxri/protocol';
import {
    agentChatPermissionModeDescription,
    agentChatPermissionModeLabel,
    agentChatPermissionModes,
    canAgentChatPlan,
    isAgentChatPermissionNextTurnOnly,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

type PermissionSnapshot = Pick<AgentChatSnapshot, 'activeTurnId' | 'permissionMode' | 'planMode'>;

/**
 * What the composer's permission trigger shows: the level in the provider's words (Codex's "Default"), or "Custom"
 * while the launch settings match no level, followed by `Plan` while plan mode is on, as on Desktop.
 */
export interface AgentChatPermissionTrigger {
    label: string;
    /**
     * Full access reads in the warning tone so the riskiest level stands out at a glance, as Desktop's shield does.
     */
    isFullAccess: boolean;
    isPlanMode: boolean;
    isInteractive: boolean;
    accessibilityLabel: string;
}

/**
 * The trigger for a Chat's permission level, or `undefined` while the snapshot reports neither a level nor plan mode (a
 * Chat that has not reported its permission yet), so nothing misleading shows. `canConfigure` is false when the device
 * may not change the level now; the trigger then stays a plain label so the reader still sees the level.
 */
export const agentChatPermissionTrigger = (
    snapshot: PermissionSnapshot | undefined,
    provider: AgentProvider | undefined,
    canConfigure: boolean,
    t: Translate = translate,
): AgentChatPermissionTrigger | undefined => {
    if (!snapshot || !provider || !('permissionMode' in snapshot || 'planMode' in snapshot))
        return undefined;
    const label = snapshot.permissionMode
        ? agentChatPermissionModeLabel(snapshot.permissionMode, provider, t)
        : t('chat.permission.custom');
    const isPlanMode = snapshot.planMode === true;
    return {
        label,
        isFullAccess: snapshot.permissionMode === 'fullAccess',
        isPlanMode,
        isInteractive: canConfigure,
        accessibilityLabel: t(
            isPlanMode ? 'chat.permission.triggerLabelPlan' : 'chat.permission.triggerLabel',
            { label },
        ),
    };
};

export interface AgentChatPermissionOption {
    /**
     * A level, or `custom` for the row that explains launch settings no level matches.
     */
    value: AgentChatPermissionMode | 'custom';
    label: string;
    description?: string;
    isSelected: boolean;
    isFullAccess: boolean;
    /**
     * The row's `testID` in kebab case (`agent-chat-permission-full-access`). Android exposes a `testID` as a resource
     * ID, and the sanitized Acceptance semantics only report lower-case IDs, so a camel-case level would be
     * untappable.
     */
    testID: string;
}

const permissionOptionTestID = (value: AgentChatPermissionMode | 'custom'): string =>
    `agent-chat-permission-${value.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`;

/**
 * The sheet's levels: the ones the provider runs natively, least permissive first, with the Desktop menu's names and
 * one-line descriptions. A Chat whose launch settings match no level gets a checked `Custom (from launch settings)` row
 * on top, so the trigger's "Custom" has a row that explains it; choosing it changes nothing.
 */
export const agentChatPermissionOptions = (
    snapshot: Pick<AgentChatSnapshot, 'permissionMode'> | undefined,
    provider: AgentProvider,
    t: Translate = translate,
): AgentChatPermissionOption[] => {
    const current = snapshot?.permissionMode;
    const custom: AgentChatPermissionOption[] =
        current === undefined
            ? [
                  {
                      value: 'custom',
                      label: t('chat.permission.customRow'),
                      description: t('chat.permission.customRowDescription'),
                      isSelected: true,
                      isFullAccess: false,
                      testID: permissionOptionTestID('custom'),
                  },
              ]
            : [];
    return [
        ...custom,
        ...agentChatPermissionModes(provider).map((mode) => {
            const description = agentChatPermissionModeDescription(provider, mode, t);
            return {
                value: mode,
                label: agentChatPermissionModeLabel(mode, provider, t),
                ...(description && { description }),
                isSelected: mode === current,
                isFullAccess: mode === 'fullAccess',
                testID: permissionOptionTestID(mode),
            };
        }),
    ];
};

/**
 * The sheet's Plan mode switch with the Desktop words, or `undefined` for a provider without plan mode (Grok Build) or
 * a snapshot that does not report it.
 */
export const agentChatPlanModeToggle = (
    snapshot: Pick<AgentChatSnapshot, 'planMode'> | undefined,
    provider: AgentProvider,
    t: Translate = translate,
): { label: string; description: string; isOn: boolean } | undefined =>
    snapshot?.planMode === undefined || !canAgentChatPlan(provider)
        ? undefined
        : {
              label: t('chat.permission.planMode'),
              description: t('chat.permission.planModeDescription'),
              isOn: snapshot.planMode,
          };

/**
 * Codex applies a switch made during a turn only from the next turn, so the sheet says so instead of implying the
 * running turn changed. Claude Code switches in place, and Grok Build refuses a switch until the turn ends.
 */
export const agentChatPermissionSheetNote = (
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId'> | undefined,
    provider: AgentProvider,
    t: Translate = translate,
): string | undefined =>
    snapshot?.activeTurnId && isAgentChatPermissionNextTurnOnly(provider)
        ? t('chat.permission.appliesNextTurn')
        : undefined;

/**
 * The sheet's message for a failed switch, naming what the reader tried to change.
 */
export const agentChatPermissionFailureMessage = (
    change: AgentChatPermissionRequest,
    t: Translate = translate,
): string => {
    if (change.permissionMode !== undefined) return t('chat.permission.changeFailed');
    return t(change.planMode ? 'chat.permission.planOnFailed' : 'chat.permission.planOffFailed');
};

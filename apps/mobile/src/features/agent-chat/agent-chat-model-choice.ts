import type { AgentChatModelRequest, AgentChatSnapshot } from '@caxri/protocol';
import { agentChatEffortLabel, agentChatMenuModel, agentChatModelLabel } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import { translate } from '../../i18n';

type ModelSnapshot = Pick<
    AgentChatSnapshot,
    'activeTurnId' | 'effort' | 'model' | 'models' | 'ultracode'
>;

/**
 * What the composer's model row shows: the same model and effort names as the Desktop composer's menu trigger.
 * `isInteractive` is false when the provider listed no models (the row is then plain text, as on Desktop) or the device
 * cannot configure this Chat right now.
 */
export interface AgentChatModelTrigger {
    model: string;
    effort?: string;
    /**
     * Claude Code's ultracode is on, shown as the Desktop trigger's `Ultracode` mode word after the effort.
     */
    isUltracode: boolean;
    isInteractive: boolean;
    accessibilityLabel: string;
}

export const agentChatModelTrigger = (
    snapshot: ModelSnapshot | undefined,
    canConfigure: boolean,
    t: Translate = translate,
): AgentChatModelTrigger | undefined => {
    const label = agentChatModelLabel(snapshot);
    if (!label) return undefined;
    // `agentChatModelLabel` speaks English: it names an unreported model "Default" and its effort in English.
    const model = snapshot?.model ? label.model : t('chat.model.default');
    const effort =
        label.effort && snapshot?.effort ? agentChatEffortLabel(snapshot.effort, t) : label.effort;
    const isUltracode = snapshot?.ultracode === true;
    return {
        model,
        ...(effort && { effort }),
        isUltracode,
        isInteractive: canConfigure && (snapshot?.models?.length ?? 0) > 0,
        accessibilityLabel: [
            t('chat.model.triggerLabel', { model }),
            effort ? t('chat.model.triggerEffort', { effort }) : '',
            isUltracode ? t('chat.model.triggerUltracode') : '',
        ].join(''),
    };
};

/**
 * The sheet's Ultracode switch, with the Desktop menu's words, or `undefined` while the provider does not offer it for
 * the current model (any Codex or Grok Build Chat, and Claude models without it), so the row disappears with it.
 */
export const agentChatUltracodeToggle = (
    snapshot: Pick<AgentChatSnapshot, 'ultracode'> | undefined,
    t: Translate = translate,
): { label: string; description: string; isOn: boolean } | undefined =>
    snapshot?.ultracode === undefined
        ? undefined
        : {
              label: 'Ultracode',
              description: t('chat.model.ultracodeDescription'),
              isOn: snapshot.ultracode,
          };

export interface AgentChatModelOption {
    id: string;
    displayName: string;
    description?: string;
    isSelected: boolean;
}

export interface AgentChatEffortOption {
    value: string;
    label: string;
    /**
     * One line on what the level trades off, or `undefined` for a level the phone has no wording for.
     */
    description?: string;
    isDefault: boolean;
    isSelected: boolean;
}

const EFFORT_DESCRIPTIONS = {
    none: 'chat.model.effortDescription.none',
    minimal: 'chat.model.effortDescription.minimal',
    low: 'chat.model.effortDescription.low',
    medium: 'chat.model.effortDescription.medium',
    high: 'chat.model.effortDescription.high',
    xhigh: 'chat.model.effortDescription.xhigh',
    max: 'chat.model.effortDescription.max',
    ultra: 'chat.model.effortDescription.ultra',
} as const satisfies Record<string, TranslationKey>;

/**
 * What a reasoning effort level means. The provider snapshot lists only the level names, so the wording comes from the
 * phone's own catalog.
 */
const agentChatEffortDescription = (effort: string, t: Translate): string | undefined =>
    Object.hasOwn(EFFORT_DESCRIPTIONS, effort)
        ? t(EFFORT_DESCRIPTIONS[effort as keyof typeof EFFORT_DESCRIPTIONS])
        : undefined;

/**
 * The sheet's two lists, in the provider's order. Efforts belong to the model in use. Pass the snapshot with any
 * pending switch applied (`agentChatSelectionView`), so choosing a model shows that model's efforts at once instead of
 * the old model's until the Server's next snapshot, as the Desktop menu does.
 */
export const agentChatModelOptions = (
    snapshot: ModelSnapshot | undefined,
    t: Translate = translate,
): { models: AgentChatModelOption[]; efforts: AgentChatEffortOption[] } => {
    const models = snapshot?.models ?? [];
    const current = snapshot ? agentChatMenuModel({ model: snapshot.model, models }) : undefined;
    return {
        models: models.map((model) => ({
            id: model.id,
            displayName: model.displayName,
            ...(model.description && { description: model.description }),
            isSelected: model.id === current?.id,
        })),
        efforts: (current?.efforts ?? []).map((effort) => ({
            value: effort,
            label: agentChatEffortLabel(effort, t),
            ...(agentChatEffortDescription(effort, t) && {
                description: agentChatEffortDescription(effort, t),
            }),
            isDefault: effort === current?.defaultEffort,
            isSelected: effort === snapshot?.effort,
        })),
    };
};

/**
 * The footer's disabled reasons for the sheet's two sections. A dropped connection blocks both the same way, so it is
 * said once for the model and permissions together instead of twice; any other reason (access, handed off, failed) is
 * kept per section, and identical wording is still shown once.
 */
export const agentChatSettingsDisabledReasons = (
    reasons: { configure: string | undefined; permission: string | undefined },
    t: Translate = translate,
): { model: string | undefined; permission: string | undefined } => {
    const { configure, permission } = reasons;
    if (
        configure !== undefined &&
        configure === t('chat.disabled.configure.offline') &&
        permission === t('chat.disabled.permission.offline')
    )
        return { model: t('chat.disabled.settings.offline'), permission: undefined };
    return { model: configure, permission: permission === configure ? undefined : permission };
};

/**
 * A running turn keeps the model it started with (`docs/agent-chat.md`), so the sheet says when a choice takes effect
 * instead of letting the reader think the current reply changed models.
 */
export const agentChatModelSheetNote = (
    snapshot: ModelSnapshot | undefined,
    t: Translate = translate,
): string | undefined => (snapshot?.activeTurnId ? t('chat.model.appliesNextTurn') : undefined);

/**
 * Efforts belong to a model, and Core validates an effort against the model in use. Claude Code names its model only
 * once the first turn starts, so a new Chat asks for a model before it can offer efforts.
 */
export const agentChatEffortHint = (
    snapshot: ModelSnapshot | undefined,
    t: Translate = translate,
): string | undefined =>
    (snapshot?.models?.length ?? 0) > 0 &&
    !(snapshot && agentChatMenuModel({ model: snapshot.model, models: snapshot.models }))
        ? t('chat.model.chooseModelForEffort')
        : undefined;

/**
 * The sheet's message for a failed switch, naming what the reader tried to change.
 */
export const agentChatConfigureFailureMessage = (
    change: AgentChatModelRequest,
    t: Translate = translate,
): string => {
    if (change.model !== undefined) return t('chat.model.switchModelFailed');
    if (change.effort !== undefined) return t('chat.model.switchEffortFailed');
    return t(change.ultracode ? 'chat.model.ultracodeOnFailed' : 'chat.model.ultracodeOffFailed');
};

/**
 * A failed `configure` as a sheet shows it, with the {@link agentChatConfigureScope} it failed under.
 */
export interface AgentChatConfigureError {
    message: string;
    scope: string;
}

/**
 * What a configure failure is about: the Chat's model, effort, ultracode, permission level, and plan mode, plus whether
 * the phone can reach the Chat. When any of them changes (the Server reported a new choice, or the connection dropped
 * or came back) the failure is stale and the sheet drops it instead of keeping an error that no longer describes the
 * Chat. The snapshot's `revision` alone is not used: it advances with every streamed token of a running turn, which
 * would clear the error before anyone could read it.
 */
export const agentChatConfigureScope = (
    snapshot:
        | Pick<
              AgentChatSnapshot,
              'effort' | 'model' | 'permissionMode' | 'planMode' | 'status' | 'ultracode'
          >
        | undefined,
    connection: { disabledReason: string | undefined; isLive: boolean },
): string =>
    JSON.stringify([
        snapshot?.model,
        snapshot?.effort,
        snapshot?.ultracode,
        snapshot?.permissionMode,
        snapshot?.planMode,
        snapshot?.status,
        connection.disabledReason,
        connection.isLive,
    ]);

/**
 * The stored failure while it still describes the Chat, otherwise `null`.
 */
export const currentAgentChatConfigureError = (
    error: AgentChatConfigureError | null,
    scope: string,
): AgentChatConfigureError | null => (error?.scope === scope ? error : null);

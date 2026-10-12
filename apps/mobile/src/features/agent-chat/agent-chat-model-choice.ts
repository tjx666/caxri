import type { AgentChatModelRequest, AgentChatSnapshot } from '@caxri/protocol';
import { agentChatEffortLabel, agentChatModelLabel, findAgentChatModel } from '@caxri/protocol';

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
): AgentChatModelTrigger | undefined => {
    const label = agentChatModelLabel(snapshot);
    if (!label) return undefined;
    const isUltracode = snapshot?.ultracode === true;
    return {
        ...label,
        isUltracode,
        isInteractive: canConfigure && (snapshot?.models?.length ?? 0) > 0,
        accessibilityLabel: `Model: ${label.model}${label.effort ? `, ${label.effort} effort` : ''}${isUltracode ? ', ultracode on' : ''}`,
    };
};

/**
 * The sheet's Ultracode switch, with the Desktop menu's words, or `undefined` while the provider does not offer it for
 * the current model (any Codex or Grok Build Chat, and Claude models without it), so the row disappears with it.
 */
export const agentChatUltracodeToggle = (
    snapshot: Pick<AgentChatSnapshot, 'ultracode'> | undefined,
): { label: string; description: string; isOn: boolean } | undefined =>
    snapshot?.ultracode === undefined
        ? undefined
        : {
              label: 'Ultracode',
              description: 'Multi-agent workflows at any effort',
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
    isDefault: boolean;
    isSelected: boolean;
}

/**
 * The sheet's two lists, in the provider's order. Efforts belong to the model in use. Pass the snapshot with any
 * pending switch applied (`agentChatSelectionView`), so choosing a model shows that model's efforts at once instead of
 * the old model's until the Server's next snapshot, as the Desktop menu does.
 */
export const agentChatModelOptions = (
    snapshot: ModelSnapshot | undefined,
): { models: AgentChatModelOption[]; efforts: AgentChatEffortOption[] } => {
    const models = snapshot?.models ?? [];
    const current = findAgentChatModel(models, snapshot?.model);
    return {
        models: models.map((model) => ({
            id: model.id,
            displayName: model.displayName,
            ...(model.description && { description: model.description }),
            isSelected: model.id === current?.id,
        })),
        efforts: (current?.efforts ?? []).map((effort) => ({
            value: effort,
            label: agentChatEffortLabel(effort),
            isDefault: effort === current?.defaultEffort,
            isSelected: effort === snapshot?.effort,
        })),
    };
};

/**
 * A running turn keeps the model it started with (`docs/agent-chat.md`), so the sheet says when a choice takes effect
 * instead of letting the reader think the current reply changed models.
 */
export const agentChatModelSheetNote = (snapshot: ModelSnapshot | undefined): string | undefined =>
    snapshot?.activeTurnId ? 'Applies from the next turn.' : undefined;

/**
 * Efforts belong to a model, and Core validates an effort against the model in use. Claude Code names its model only
 * once the first turn starts, so a new Chat asks for a model before it can offer efforts.
 */
export const agentChatEffortHint = (snapshot: ModelSnapshot | undefined): string | undefined =>
    (snapshot?.models?.length ?? 0) > 0 && !findAgentChatModel(snapshot?.models, snapshot?.model)
        ? 'Choose a model to see its reasoning efforts.'
        : undefined;

/**
 * The sheet's message for a failed switch, naming what the reader tried to change.
 */
export const agentChatConfigureFailureMessage = (change: AgentChatModelRequest): string => {
    if (change.model !== undefined) return 'Unable to switch the model. Try again.';
    if (change.effort !== undefined) return 'Unable to switch the reasoning effort. Try again.';
    return change.ultracode
        ? 'Unable to turn on Ultracode. Try again.'
        : 'Unable to turn off Ultracode. Try again.';
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

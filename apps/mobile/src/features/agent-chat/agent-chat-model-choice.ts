import type { AgentChatSnapshot } from '@caxri/protocol';
import { agentChatEffortLabel, agentChatModelLabel, findAgentChatModel } from '@caxri/protocol';

type ModelSnapshot = Pick<AgentChatSnapshot, 'activeTurnId' | 'effort' | 'model' | 'models'>;

/**
 * What the composer's model row shows: the same model and effort names as the Desktop composer's menu trigger.
 * `isInteractive` is false when the provider listed no models (the row is then plain text, as on Desktop) or the device
 * cannot configure this Chat right now.
 */
export interface AgentChatModelTrigger {
    model: string;
    effort?: string;
    isInteractive: boolean;
    accessibilityLabel: string;
}

export const agentChatModelTrigger = (
    snapshot: ModelSnapshot | undefined,
    canConfigure: boolean,
): AgentChatModelTrigger | undefined => {
    const label = agentChatModelLabel(snapshot);
    if (!label) return undefined;
    return {
        ...label,
        isInteractive: canConfigure && (snapshot?.models?.length ?? 0) > 0,
        accessibilityLabel: `Model: ${label.model}${label.effort ? `, ${label.effort} effort` : ''}`,
    };
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
 * The sheet's two lists, in the provider's order. Efforts belong to the model in use, so switching the model shows the
 * new model's efforts as soon as the snapshot reports it, as the Desktop menu does.
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

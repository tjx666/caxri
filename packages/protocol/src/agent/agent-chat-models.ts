import { CaxriError } from '../transport/errors.js';
import type { AgentChatModel, AgentChatSnapshot } from './agent-chat-contract.js';

/**
 * The listed model a provider-reported model identifier belongs to. Claude Code lists aliases (`opus`) but reports the
 * full model it resolved (`claude-opus-5-5`), so both identifiers match.
 */
export function findAgentChatModel(
    models: readonly AgentChatModel[] | undefined,
    model: string | undefined,
): AgentChatModel | undefined {
    if (!models || !model) return undefined;
    return models.find((candidate) => candidate.id === model || candidate.resolvedId === model);
}

/**
 * A model or effort switch as a Client asks for it, by identifier.
 */
export interface AgentChatModelRequest {
    model?: string;
    effort?: string;
}

/**
 * A validated model or effort switch, as a provider session applies it.
 */
export interface AgentChatModelChange {
    /**
     * The model to switch to; absent when only the effort changes.
     */
    model?: AgentChatModel;
    /**
     * The effort to switch to; absent when the provider should keep the current one.
     */
    effort?: string;
}

/**
 * Validates a requested switch against what the provider listed, so a stale Client cannot send a model or effort the
 * provider never offered. Switching to a model that does not accept the current effort falls back to that model's
 * default, because a provider handed an effort its model rejects fails the next turn.
 */
export function resolveAgentChatModelChange(
    snapshot: Pick<AgentChatSnapshot, 'effort' | 'model' | 'models'>,
    change: AgentChatModelRequest,
): AgentChatModelChange {
    const model =
        change.model === undefined
            ? undefined
            : snapshot.models?.find((candidate) => candidate.id === change.model);
    if (!model && change.model !== undefined)
        throw new CaxriError('VALIDATION', `${change.model} is not available in this Chat`);
    const target = model ?? findAgentChatModel(snapshot.models, snapshot.model);
    if (change.effort !== undefined) {
        if (!target?.efforts.includes(change.effort))
            throw new CaxriError('VALIDATION', `${change.effort} effort is not available`);
        return { ...(model && { model }), effort: change.effort };
    }
    if (!model) return {};
    const keepsEffort =
        snapshot.effort === undefined ||
        model.efforts.length === 0 ||
        model.efforts.includes(snapshot.effort);
    return {
        model,
        ...(!keepsEffort && model.defaultEffort && { effort: model.defaultEffort }),
    };
}

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
    if (keepsEffort) return { model };
    const effort = model.defaultEffort ?? closestEffort(model.efforts, snapshot.effort);
    return { model, ...(effort && { effort }) };
}

/**
 * The provider-neutral order of the effort names Codex and Claude Code use, lowest first.
 */
const EFFORT_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * For a model that names no default effort (Claude Code lists none), the strongest effort it accepts that does not
 * exceed the current one, so switching models never raises the cost unasked. An effort outside the known ladder falls
 * back to the model's lowest.
 */
function closestEffort(
    efforts: readonly string[],
    current: string | undefined,
): string | undefined {
    const rank = current === undefined ? -1 : EFFORT_LADDER.indexOf(current);
    const lower = efforts.filter((effort) => {
        const candidate = EFFORT_LADDER.indexOf(effort);
        return candidate !== -1 && candidate <= rank;
    });
    return lower.at(-1) ?? efforts[0];
}

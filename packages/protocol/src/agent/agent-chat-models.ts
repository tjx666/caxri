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
 * A model, effort, or ultracode switch as a Client asks for it, by identifier.
 */
export interface AgentChatModelRequest {
    model?: string;
    effort?: string;
    ultracode?: boolean;
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
    /**
     * Turns Claude Code's ultracode on or off; absent when it should stay as it is.
     */
    ultracode?: boolean;
}

/**
 * Validates a requested switch against what the provider listed, so a stale Client cannot send a model or effort the
 * provider never offered. Switching to a model that does not accept the current effort falls back to that model's
 * default, because a provider handed an effort its model rejects fails the next turn.
 */
export function resolveAgentChatModelChange(
    snapshot: Pick<AgentChatSnapshot, 'effort' | 'model' | 'models' | 'ultracode'>,
    change: AgentChatModelRequest,
): AgentChatModelChange {
    if (change.ultracode !== undefined && snapshot.ultracode === undefined)
        throw new CaxriError('VALIDATION', 'Ultracode is not available in this Chat');
    const ultracode = change.ultracode === undefined ? {} : { ultracode: change.ultracode };
    return { ...resolveModelAndEffort(snapshot, change), ...ultracode };
}

function resolveModelAndEffort(
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
 * A model picker's optimistic state, shared by the Desktop menu and the phone sheet. A switch takes a round trip
 * through Server Core and the provider, and a picker that kept showing the old choice until the projection caught up
 * read as the tap being ignored, and offered the old model's efforts meanwhile. A picker shows the requested choice at
 * once, marked as pending, until the snapshot settles it.
 */
export interface AgentChatPendingSelection {
    change: AgentChatModelRequest;
    /**
     * The model, effort, and ultracode the snapshot reported when the switch was requested.
     */
    baseline: { model: string | undefined; effort: string | undefined; ultracode?: boolean };
    /**
     * Server Core accepted the switch, so any change in the reported model or effort is its answer, even one that does
     * not spell the requested identifier (an alias that resolves to another id).
     */
    isAccepted: boolean;
}

type SelectionSnapshot = Pick<AgentChatSnapshot, 'effort' | 'model' | 'models' | 'ultracode'>;

/**
 * Whether the snapshot now answers the pending switch: it reports the requested model, effort, and ultracode, or, once
 * the switch was accepted, it changed from the baseline at all.
 */
export function isAgentChatSelectionSettled(
    pending: AgentChatPendingSelection,
    snapshot: SelectionSnapshot | undefined,
): boolean {
    const { change } = pending;
    const isModelConfirmed =
        change.model === undefined ||
        snapshot?.model === change.model ||
        findAgentChatModel(snapshot?.models, snapshot?.model)?.id === change.model;
    const isEffortConfirmed = change.effort === undefined || snapshot?.effort === change.effort;
    const isUltracodeConfirmed =
        change.ultracode === undefined || snapshot?.ultracode === change.ultracode;
    if (isModelConfirmed && isEffortConfirmed && isUltracodeConfirmed) return true;
    return (
        pending.isAccepted &&
        (snapshot?.model !== pending.baseline.model ||
            snapshot?.effort !== pending.baseline.effort ||
            snapshot?.ultracode !== pending.baseline.ultracode)
    );
}

/**
 * The snapshot as the picker shows it while a switch is pending. A new model keeps the current effort when it offers
 * it, and otherwise shows its default, which is what the provider applies.
 */
export function agentChatSelectionView<Snapshot extends SelectionSnapshot>(
    snapshot: Snapshot,
    pending: AgentChatPendingSelection | undefined,
): Snapshot {
    if (!pending) return snapshot;
    const { change } = pending;
    const model = change.model ?? snapshot.model;
    let effort = change.effort ?? snapshot.effort;
    if (change.model !== undefined && change.effort === undefined) {
        const next = findAgentChatModel(snapshot.models, change.model);
        if (next && (effort === undefined || !next.efforts.includes(effort)))
            effort = next.defaultEffort;
    }
    const ultracode = change.ultracode ?? snapshot.ultracode;
    return { ...snapshot, model, effort, ...(ultracode !== undefined && { ultracode }) };
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

/**
 * Display names for the effort levels the providers use; an unknown level is shown capitalized.
 */
const EFFORT_LABELS: Record<string, string> = {
    none: 'None',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Max',
};

/**
 * The display name of one effort level, shared by the Desktop menu and the phone sheet.
 */
export function agentChatEffortLabel(effort: string): string {
    return EFFORT_LABELS[effort] ?? `${effort.charAt(0).toUpperCase()}${effort.slice(1)}`;
}

/**
 * The model picker's trigger: the model's listed name and the effort the next turn uses, as Codex shows `GPT-5.6 Sol
 * Extra high`. A model the provider did not list keeps its raw identifier.
 */
export function agentChatModelLabel(
    snapshot: Pick<AgentChatSnapshot, 'effort' | 'model' | 'models'> | undefined,
): { model: string; effort?: string } | undefined {
    // Claude Code reports the model in each turn's init message, so a new Chat lists its models before it names the
    // one in use; the picker still opens and reads as the provider default until then, with the effort Claude Code
    // already reported it will apply.
    if (!snapshot?.model)
        return snapshot?.models?.length
            ? {
                  model: 'Default',
                  ...(snapshot.effort && { effort: agentChatEffortLabel(snapshot.effort) }),
              }
            : undefined;
    const listed = findAgentChatModel(snapshot.models, snapshot.model);
    const effort =
        snapshot.effort && (listed?.efforts.length ?? 1) > 0
            ? agentChatEffortLabel(snapshot.effort)
            : undefined;
    const model = listed && concreteModelName(snapshot.models ?? [], listed, snapshot.model);
    return { model: model ?? snapshot.model, ...(effort && { effort }) };
}

/**
 * The name the picker shows for the model in use. Claude Code lists its default as an alias, "Default (recommended)",
 * whose description names the model it currently resolves to ("Use the default model (currently Opus 5.5)"); that name
 * says which model actually runs. Failing that, a named entry that resolves to the same model does; the default may add
 * a variant suffix (`claude-opus-5-5[1m]`) the named entry lacks, so the suffix is ignored when matching. With neither
 * the alias reads as plain "Default".
 */
function concreteModelName(
    models: readonly AgentChatModel[],
    listed: AgentChatModel,
    model: string,
): string {
    if (listed.id !== 'default') return listed.displayName;
    const current = /\(currently ([^)]+)\)/.exec(listed.description ?? '')?.[1]?.trim();
    if (current) return current;
    const base = model.replace(/\[[^\]]*\]$/, '');
    const named = models.find(
        (candidate) =>
            candidate.id !== 'default' &&
            [candidate.id, candidate.resolvedId].some((id) => id === model || id === base),
    );
    return named?.displayName ?? listed.displayName.replace(/\s*\(recommended\)$/i, '');
}

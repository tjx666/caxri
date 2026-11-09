import type {
    AgentChatModel,
    AgentChatModelChange,
    AgentChatModelRequest,
    AgentChatSnapshot,
} from '@caxri/protocol';
import { agentChatMenuModel, findAgentChatModel } from '@caxri/protocol';

type ChoiceSnapshot = Pick<AgentChatSnapshot, 'effort' | 'fast' | 'model' | 'models' | 'ultracode'>;

/**
 * A stored choice key a restore dropped, and why: the provider no longer lists the model, the model no longer accepts
 * the effort or Fast mode, or the Chat does not offer ultracode or Fast mode right now.
 */
export type ChatChoiceDrop = 'model' | 'effort' | 'ultracode' | 'fast';

/**
 * The Chat's choice after a picker switch: the keys the user picked replace the stored ones. A key the switch moved on
 * its own (a new model that rejects the stored effort falls back to its default, or withdraws Fast mode) stops being
 * the user's, so it goes back to following the global default instead of pinning the fallback.
 */
export function nextChatChoice(
    stored: AgentChatModelRequest,
    request: AgentChatModelRequest,
    resolved: AgentChatModelChange,
): AgentChatModelRequest {
    const next: AgentChatModelRequest = { ...stored, ...request };
    if (request.effort === undefined && resolved.effort !== undefined) delete next.effort;
    if (request.fast === undefined && resolved.fast !== undefined) delete next.fast;
    return next;
}

export function hasChatChoice(choice: AgentChatModelRequest): boolean {
    return (
        choice.model !== undefined ||
        choice.effort !== undefined ||
        choice.ultracode !== undefined ||
        choice.fast !== undefined
    );
}

/**
 * The part of a stored choice the freshly started provider still accepts, checked key by key so one stale key (a
 * retired model, an effort the account lost) does not discard the rest. Keys that already match the snapshot are left
 * out, so a Chat whose provider restored the choice itself (Codex's `thread/resume`) sends nothing.
 *
 * Returns `undefined` when the provider listed no models: an unlisted model is not proof the choice is invalid (the
 * listing can fail), so the choice is kept for the next start instead of being judged.
 */
export function restorableChatChoice(
    snapshot: ChoiceSnapshot,
    stored: AgentChatModelRequest,
): { request: AgentChatModelRequest; dropped: ChatChoiceDrop[] } | undefined {
    if (!snapshot.models?.length) return undefined;
    const request: AgentChatModelRequest = {};
    const dropped: ChatChoiceDrop[] = [];
    let target: AgentChatModel | undefined = agentChatMenuModel(snapshot);
    if (stored.model !== undefined) {
        const model = snapshot.models.find((candidate) => candidate.id === stored.model);
        if (!model) dropped.push('model');
        else {
            target = model;
            const current = findAgentChatModel(snapshot.models, snapshot.model);
            if (current?.id !== model.id) request.model = model.id;
        }
    }
    if (stored.effort !== undefined) {
        if (!target?.efforts.includes(stored.effort)) dropped.push('effort');
        else if (request.model !== undefined || snapshot.effort !== stored.effort)
            request.effort = stored.effort;
    }
    if (stored.ultracode !== undefined) {
        if (snapshot.ultracode === undefined) dropped.push('ultracode');
        else if (snapshot.ultracode !== stored.ultracode) request.ultracode = stored.ultracode;
    }
    if (stored.fast !== undefined) {
        const isOffered =
            snapshot.fast !== undefined && (target ? target.fast !== undefined : true);
        if (!isOffered && stored.fast) dropped.push('fast');
        else if (snapshot.fast !== undefined && snapshot.fast !== stored.fast)
            request.fast = stored.fast;
    }
    return { request, dropped };
}

/**
 * The global default an Agent resolves to, as `AgentChatDefaultsService.resolve` reads it from the launch settings and
 * the Agent's own config file. A key is absent when neither names it, so the provider's built-in default applies.
 */
export interface AgentChatDefaultChoice {
    model?: string;
    effort?: string;
    ultracode?: boolean;
    fast?: boolean;
}

/**
 * The switch that puts a Chat back on the global default: the default model (or the provider's `default` alias when
 * none is configured), the default effort when that model accepts it and otherwise the model's own default, and
 * ultracode and Fast mode off unless the default turns them on. Only keys that differ from the snapshot are sent.
 */
export function defaultChatChoiceRequest(
    snapshot: ChoiceSnapshot,
    defaults: AgentChatDefaultChoice,
): AgentChatModelRequest {
    const models = snapshot.models ?? [];
    const request: AgentChatModelRequest = {};
    const configured =
        defaults.model === undefined
            ? undefined
            : (models.find((candidate) => candidate.id === defaults.model) ??
              findAgentChatModel(models, defaults.model));
    const fallback = models.find((candidate) => candidate.id === 'default');
    const target = configured ?? fallback ?? findAgentChatModel(models, snapshot.model);
    const current = findAgentChatModel(models, snapshot.model) ?? agentChatMenuModel(snapshot);
    if (target && current?.id !== target.id) request.model = target.id;
    const effort =
        defaults.effort !== undefined && target?.efforts.includes(defaults.effort)
            ? defaults.effort
            : target?.defaultEffort;
    if (effort !== undefined && (request.model !== undefined || snapshot.effort !== effort))
        request.effort = effort;
    const ultracode = defaults.ultracode ?? false;
    if (snapshot.ultracode !== undefined && snapshot.ultracode !== ultracode)
        request.ultracode = ultracode;
    const fast = defaults.fast ?? false;
    if (snapshot.fast !== undefined && snapshot.fast !== fast && (!fast || target?.fast))
        request.fast = fast;
    return request;
}

import type { AgentChatDefaultOverride, AgentChatDefaults } from '@caxri/protocol';
import { agentChatEffortLabel, findAgentChatModel } from '@caxri/protocol';

import type { Translate } from '../../../i18n';

/**
 * Claude Code's alias for the model the account recommends. The select's "Agent's default" option stands for it, so a
 * file naming it reads as that option and the list does not offer it twice.
 */
const DEFAULT_ALIAS = 'default';

export interface ChatDefaultModelOption {
    value: string;
    label: string;
}

/**
 * The model the Default model field shows as chosen: the listed id the file's value belongs to (Claude Code may save
 * the full model an alias resolves to), the file's own value when no listed model matches, or `undefined` while the
 * file leaves the model to the Agent.
 */
export function chatDefaultModelValue(
    defaults: Pick<AgentChatDefaults, 'model' | 'models'>,
): string | undefined {
    const { model } = defaults;
    if (!model || model === DEFAULT_ALIAS) return undefined;
    return findAgentChatModel(defaults.models, model)?.id ?? model;
}

/**
 * The models the Default model select offers after its "Agent's default" option: the listed ones without Claude Code's
 * `default` alias, plus the file's own value when the list does not name it, so the select still reads what the file
 * says.
 */
export function chatDefaultModelOptions(
    defaults: Pick<AgentChatDefaults, 'model' | 'models'>,
): ChatDefaultModelOption[] {
    const options = defaults.models
        .filter((model) => model.id !== DEFAULT_ALIAS)
        .map((model) => ({ value: model.id, label: model.displayName || model.id }));
    const chosen = chatDefaultModelValue(defaults);
    if (chosen && options.every((option) => option.value !== chosen))
        options.push({ value: chosen, label: chosen });
    return options;
}

type EffortDefaults = Pick<
    AgentChatDefaults,
    'builtInModel' | 'effort' | 'model' | 'models' | 'provider'
>;

/**
 * The efforts the chosen model lists, or the Agent's built-in model while none is chosen, without Claude Code's `max`,
 * which applies to one session only and is never saved. `undefined` when no listed model says.
 */
function listedEfforts(defaults: Omit<EffortDefaults, 'effort'>): string[] | undefined {
    const listed = findAgentChatModel(
        defaults.models,
        chatDefaultModelValue(defaults) ?? defaults.builtInModel,
    );
    return listed?.efforts.filter((effort) => defaults.provider !== 'claude' || effort !== 'max');
}

/**
 * The efforts the Default effort select offers, plus the file's current one when the model does not list it, so the
 * select still reads what the file says. `undefined` when no listed model says, so the field takes free text instead.
 */
export function chatDefaultEffortOptions(defaults: EffortDefaults): string[] | undefined {
    const efforts = listedEfforts(defaults);
    if (efforts && defaults.effort && !efforts.includes(defaults.effort))
        return [...efforts, defaults.effort];
    return efforts;
}

/**
 * The write a Default model choice sends (`null`: leave the model to the Agent). An effort the new model does not
 * accept is cleared with it, so the Agent applies that model's own default instead of one it would refuse.
 */
export function chatDefaultModelChange(
    defaults: Omit<EffortDefaults, 'model'>,
    model: string | null,
): { model: string | null; effort?: null } {
    const efforts = listedEfforts({ ...defaults, model: model ?? undefined });
    const isEffortRefused =
        defaults.effort !== undefined &&
        efforts !== undefined &&
        !efforts.includes(defaults.effort);
    return isEffortRefused ? { model, effort: null } : { model };
}

/**
 * The line under a key that a higher layer decides, naming that layer and its value; `undefined` while the config file
 * decides. Server Core lists one override per key, the highest layer first.
 */
export function chatDefaultOverrideText(
    t: Translate,
    overrides: readonly AgentChatDefaultOverride[],
    key: AgentChatDefaultOverride['key'],
): string | undefined {
    const override = overrides.find((candidate) => candidate.key === key);
    if (!override) return undefined;
    let value = override.value;
    if (key === 'effort') value = agentChatEffortLabel(override.value, t);
    else if (key === 'ultracode')
        value = t(
            override.value === 'true'
                ? 'settings.chatDefaults.ultracodeValue.on'
                : 'settings.chatDefaults.ultracodeValue.off',
        );
    return t(`settings.chatDefaults.override.${override.source}`, { value });
}

import type { AgentProvider, AppSettings, DelegationType } from '@caxri/protocol';
import {
    defaultDelegationTypeBinding,
    delegationEffortSchema,
    isDelegationEffortSupported,
} from '@caxri/protocol';

type DelegationSettings = AppSettings['agents.delegation'];

/**
 * The Agent, model and effort one delegation type runs on, as `agents.delegation.types.<type>` stores it.
 */
export type TypeBinding = NonNullable<DelegationSettings['types'][DelegationType]>;

/**
 * Where a binding lives: the base `types` map, or one calling Agent's own `callers.<caller>.types` map.
 */
export type BindingScope = { caller: AgentProvider } | { caller?: undefined };

/**
 * The efforts the schema accepts for this Agent and model, lowest first. The same check validates the write, so the
 * control never offers a value that would be rejected.
 */
export function supportedEfforts(
    provider: AgentProvider,
    model: string | undefined,
): Array<NonNullable<TypeBinding['effort']>> {
    return delegationEffortSchema.options.filter((effort) =>
        isDelegationEffortSupported(provider, model, effort),
    );
}

/**
 * A copy of `record` without `key`.
 */
function without<T extends object, K extends keyof T>(record: T, key: K): Omit<T, K> {
    const copy = { ...record };
    delete copy[key];
    return copy;
}

/**
 * Drops the effort when the Agent and model no longer accept it, so a change never leaves a binding the schema rejects.
 */
function withSupportedEffort(binding: TypeBinding): TypeBinding {
    if (isDelegationEffortSupported(binding.provider, binding.model, binding.effort))
        return binding;
    return without(binding, 'effort');
}

/**
 * The binding a type runs on in this scope: the stored one, or the built-in default that applies when none is stored.
 * Both the unbound controls' placeholders and "Add an override" start from it, so they cannot disagree.
 */
export function resolveTypeBinding(
    type: DelegationType,
    binding: TypeBinding | undefined,
    caller: AgentProvider | undefined,
): TypeBinding {
    return binding ?? defaultDelegationTypeBinding(type, caller);
}

/**
 * The binding after the user picks another Agent. A model name belongs to one Agent, so it is cleared; the effort stays
 * only when the new Agent accepts it. Picking the Agent an unbound type already runs on (`defaultBinding`) keeps that
 * default's tuned model and effort instead of silently dropping them.
 */
export function changeBindingProvider(
    binding: TypeBinding | undefined,
    provider: AgentProvider,
    defaultBinding?: TypeBinding,
): TypeBinding {
    if (binding?.provider === provider) return binding;
    if (!binding && defaultBinding?.provider === provider) return defaultBinding;
    return withSupportedEffort({ provider, ...(binding?.effort && { effort: binding.effort }) });
}

/**
 * The binding after the model text changes. Blank text means the provider's default model.
 */
export function changeBindingModel(binding: TypeBinding, text: string): TypeBinding {
    const model = text.trim();
    const rest = without(binding, 'model');
    return withSupportedEffort(model === '' ? rest : { ...rest, model });
}

/**
 * The binding after the effort changes; `undefined` means the default effort.
 */
export function changeBindingEffort(
    binding: TypeBinding,
    effort: TypeBinding['effort'],
): TypeBinding {
    const rest = without(binding, 'effort');
    return effort === undefined ? rest : withSupportedEffort({ ...rest, effort });
}

/**
 * The whole setting with one binding replaced, or removed when `binding` is `undefined`. Presets, the other types, the
 * other callers, and every other field survive; a caller left with nothing is dropped so the file stays tidy.
 */
export function setTypeBinding(
    value: DelegationSettings,
    type: DelegationType,
    scope: BindingScope,
    binding: TypeBinding | undefined,
): DelegationSettings {
    const replace = (types: DelegationSettings['types'] | undefined) => {
        const others = without(types ?? {}, type);
        return binding ? { ...others, [type]: binding } : others;
    };
    const { caller } = scope;
    if (caller === undefined) return { ...value, types: replace(value.types) };
    const rule = value.callers[caller] ?? {};
    const ruleRest = without(rule, 'types');
    const types = replace(rule.types);
    const next = Object.keys(types).length > 0 ? { ...ruleRest, types } : ruleRest;
    const otherCallers = without(value.callers, caller);
    return {
        ...value,
        callers: Object.keys(next).length > 0 ? { ...otherCallers, [caller]: next } : otherCallers,
    };
}

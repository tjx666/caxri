import { z } from 'zod';

export const delegationProviderSchema = z.enum(['claude', 'codex', 'grok']);
export const delegationPresetNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
export const delegationModelSchema = z.string().trim().min(1).max(256);
export const delegationEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/**
 * Reasoning efforts Grok Build's CLI accepts (`grok --reasoning-effort`). Its Chat protocol lists models without them.
 */
export const GROK_REASONING_EFFORTS = ['low', 'medium', 'high'] as const;

/**
 * Preserve dianjiang's model-aware validation without blocking future model names. These are explicit requested
 * settings, not claims about the provider's applied effort or an organization's permitted model access.
 *
 * @see https://github.com/tjx666/dianjiang/tree/main/src/core/adapters
 * @see https://code.claude.com/docs/en/model-config#adjust-effort-level
 */
export function isDelegationEffortSupported(
    provider: z.infer<typeof delegationProviderSchema>,
    model: string | undefined,
    effort: string | undefined,
): boolean {
    if (effort === undefined) return true;
    if (provider === 'grok') return (GROK_REASONING_EFFORTS as readonly string[]).includes(effort);
    if (provider === 'claude') return ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort);
    const olderModels = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'];
    if (model && olderModels.includes(model))
        return ['low', 'medium', 'high', 'xhigh'].includes(effort);
    if (model === 'gpt-5.6-luna') return ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort);
    return delegationEffortSchema.safeParse(effort).success;
}

/**
 * Delegation depth bounds, shared by this schema and the Settings row that edits `maxDepth`, so the field and its
 * control cannot drift apart. Depth 1 is the first delegation: the Agent the user started may bring in one helper, and
 * that helper works alone.
 */
export const MIN_DELEGATION_DEPTH = 1;
export const MAX_DELEGATION_DEPTH = 8;
export const DEFAULT_DELEGATION_DEPTH = 2;

const descriptionSchema = z.string().trim().min(1).max(2048);
const instructionsSchema = z.string().trim().min(1).max(8192);
const selectionShape = {
    provider: delegationProviderSchema,
    model: delegationModelSchema.optional(),
    effort: delegationEffortSchema.optional(),
};

export const delegationSelectionSchema = z.strictObject({
    ...selectionShape,
    preset: delegationPresetNameSchema.optional(),
});

const bindingSchema = z.strictObject({
    ...selectionShape,
    useWhen: descriptionSchema.optional(),
    dontUseWhen: descriptionSchema.optional(),
});
export const delegationPresetSchema = z.strictObject({
    ...selectionShape,
    name: delegationPresetNameSchema,
    useWhen: descriptionSchema,
    dontUseWhen: descriptionSchema.optional(),
    instructions: instructionsSchema.optional(),
});
const callerSchema = z.strictObject({
    presets: z.record(delegationPresetNameSchema, bindingSchema).optional(),
    exclude: z.array(delegationPresetNameSchema).max(32).optional(),
    prepend: instructionsSchema.optional(),
    append: instructionsSchema.optional(),
});

export const agentDelegationSettingsSchema = z
    .strictObject({
        maxDepth: z
            .number()
            .int()
            .min(MIN_DELEGATION_DEPTH)
            .max(MAX_DELEGATION_DEPTH)
            .default(DEFAULT_DELEGATION_DEPTH),
        presets: z.array(delegationPresetSchema).max(32).default([]),
        callers: z.partialRecord(delegationProviderSchema, callerSchema).default({}),
    })
    .superRefine((settings, context) => {
        const names = new Set(settings.presets.map((preset) => preset.name));
        const issue = (message: string) => context.addIssue({ code: 'custom', message });
        if (names.size !== settings.presets.length) issue('Delegation preset names must be unique');
        for (const preset of settings.presets)
            if (!isDelegationEffortSupported(preset.provider, preset.model, preset.effort))
                issue(`Unsupported effort for delegation preset ${preset.name}`);
        for (const [provider, caller] of Object.entries(settings.callers)) {
            const excluded = caller.exclude ?? [];
            for (const name of excluded) {
                if (!names.has(name)) issue(`Caller ${provider} excludes an unknown preset`);
                if (caller.presets && Object.hasOwn(caller.presets, name))
                    issue(`Caller ${provider} both excludes and overrides ${name}`);
            }
            const bindings = Object.entries(caller.presets ?? {});
            for (const [name, binding] of bindings) {
                if (!names.has(name)) issue(`Caller ${provider} overrides an unknown preset`);
                if (!isDelegationEffortSupported(binding.provider, binding.model, binding.effort))
                    issue(`Unsupported effort for caller ${provider} preset ${name}`);
            }
        }
    })
    .default({ maxDepth: DEFAULT_DELEGATION_DEPTH, presets: [], callers: {} });

export const delegationRosterSchema = z.strictObject({
    maxDepth: z.number().int().min(MIN_DELEGATION_DEPTH).max(MAX_DELEGATION_DEPTH),
    presets: z.array(delegationPresetSchema.omit({ instructions: true })).max(32),
    prepend: instructionsSchema.optional(),
    append: instructionsSchema.optional(),
});

export type AgentDelegationSettings = z.infer<typeof agentDelegationSettingsSchema>;
export type DelegationSelection = z.infer<typeof delegationSelectionSchema>;
export type DelegationRoster = z.infer<typeof delegationRosterSchema>;

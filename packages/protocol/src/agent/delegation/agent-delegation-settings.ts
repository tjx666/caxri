import { z } from 'zod';

import { agentProviderIds } from '../agents.js';

/**
 * Delegation covers every hosted provider, so the set derives from the catalog instead of repeating its ids.
 */
export const delegationProviderSchema = z.enum(agentProviderIds);
export const delegationPresetNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
/**
 * Most presets one profile may hold; shared by the schema, the import diff and the import issue vocabulary.
 */
export const MAX_DELEGATION_PRESETS = 32;
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
    if (provider === 'claude' || provider === 'antigravity')
        return ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort);
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

/**
 * Machine reasons the cross-field checks below attach to their issues (`params.reason`).
 */
export type DelegationCustomIssueReason =
    'duplicate_name' | 'excluded_and_overridden' | 'unknown_preset' | 'unsupported_effort';

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
const delegationPresetSchema = z.strictObject({
    ...selectionShape,
    name: delegationPresetNameSchema,
    useWhen: descriptionSchema,
    dontUseWhen: descriptionSchema.optional(),
    instructions: instructionsSchema.optional(),
});
const callerSchema = z.strictObject({
    presets: z.record(delegationPresetNameSchema, bindingSchema).optional(),
    exclude: z.array(delegationPresetNameSchema).max(MAX_DELEGATION_PRESETS).optional(),
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
        presets: z.array(delegationPresetSchema).max(MAX_DELEGATION_PRESETS).default([]),
        callers: z.partialRecord(delegationProviderSchema, callerSchema).default({}),
        /**
         * Whether an Agent may read what the Agent Chats it delegated to did (`agent.delegation.transcript`), so it can
         * check a delegated task's work without interrupting it. Off answers every read with `disabled`.
         */
        readChildChat: z.boolean().default(true),
        /**
         * Whether the Agent that delegated a task may approve the permission requests of its delegated Chat that fall
         * within its own permission. Off sends every request to the user. A request outside the delegating Agent's
         * permission always goes to the user.
         */
        approval: z.boolean().default(true),
    })
    .superRefine((settings, context) => {
        const names = new Set(settings.presets.map((preset) => preset.name));
        /**
         * Every custom issue carries a location and a closed `reason`, so the import path can report it without
         * forwarding the message text.
         */
        const issue = (
            message: string,
            reason: DelegationCustomIssueReason,
            path: Array<string | number>,
        ) => context.addIssue({ code: 'custom', message, path, params: { reason } });
        if (names.size !== settings.presets.length)
            issue('Delegation preset names must be unique', 'duplicate_name', ['presets']);
        settings.presets.forEach((preset, index) => {
            if (!isDelegationEffortSupported(preset.provider, preset.model, preset.effort))
                issue(
                    `Unsupported effort for delegation preset ${preset.name}`,
                    'unsupported_effort',
                    ['presets', index, 'effort'],
                );
        });
        for (const [provider, caller] of Object.entries(settings.callers)) {
            const excluded = caller.exclude ?? [];
            excluded.forEach((name, index) => {
                if (!names.has(name))
                    issue(`Caller ${provider} excludes an unknown preset`, 'unknown_preset', [
                        'callers',
                        provider,
                        'exclude',
                        index,
                    ]);
                if (caller.presets && Object.hasOwn(caller.presets, name))
                    issue(
                        `Caller ${provider} both excludes and overrides ${name}`,
                        'excluded_and_overridden',
                        ['callers', provider, 'exclude', index],
                    );
            });
            const overrides = Object.entries(caller.presets ?? {});
            for (const [name, binding] of overrides) {
                if (!names.has(name))
                    issue(`Caller ${provider} overrides an unknown preset`, 'unknown_preset', [
                        'callers',
                        provider,
                        'presets',
                        name,
                    ]);
                if (!isDelegationEffortSupported(binding.provider, binding.model, binding.effort))
                    issue(
                        `Unsupported effort for caller ${provider} preset ${name}`,
                        'unsupported_effort',
                        ['callers', provider, 'presets', name, 'effort'],
                    );
            }
        }
    })
    .default({
        maxDepth: DEFAULT_DELEGATION_DEPTH,
        presets: [],
        callers: {},
        readChildChat: true,
        approval: true,
    });

export const delegationRosterSchema = z.strictObject({
    maxDepth: z.number().int().min(MIN_DELEGATION_DEPTH).max(MAX_DELEGATION_DEPTH),
    presets: z
        .array(delegationPresetSchema.omit({ instructions: true }))
        .max(MAX_DELEGATION_PRESETS),
    prepend: instructionsSchema.optional(),
    append: instructionsSchema.optional(),
});

export type AgentDelegationSettings = z.infer<typeof agentDelegationSettingsSchema>;
export type DelegationSelection = z.infer<typeof delegationSelectionSchema>;
export type DelegationRoster = z.infer<typeof delegationRosterSchema>;

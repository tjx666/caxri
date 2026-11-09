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
 * How long the user must leave a Session they took over alone (no window shows it, no phone watches it, its Agent is
 * idle) before `autoHandBack` gives it back. Long enough to work in other Sessions and return without losing it (five
 * minutes handed back a Session the user was still discussing while they waited on another), short enough that a
 * forgotten takeover does not stall the delegating Agent's plan for the rest of the day.
 */
export const AUTO_HAND_BACK_AFTER_MS = 30 * 60_000;

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

/**
 * The tasks Caxri knows how to ask another Agent for without any configuration (`agent delegate create --type`). A type
 * owns its product behavior (the private instructions, how Clients present it); every type opens a `consult` Session,
 * which takes no sidebar row and opens beside the asking Chat; Settings only choose which Agent runs it. A preset is
 * the user's own named binding for everything else.
 *
 * - `second-opinion`: an independent view on a hard decision or hypothesis; changes no files.
 * - `review`: a review of code changes by another Agent; changes no files.
 * - `computer-use`: operating a signed-in browser or desktop app; it changes state outside the repository and may need
 *   the user to sign in, which the parent's record opens beside its Chat.
 * - `x-search`: a live X (Twitter) lookup of posts, threads, accounts, or what people say about a topic; changes no
 *   files.
 */
export const DELEGATION_TYPES = ['second-opinion', 'review', 'computer-use', 'x-search'] as const;
export const delegationTypeSchema = z.enum(DELEGATION_TYPES);
export type DelegationType = z.infer<typeof delegationTypeSchema>;

/**
 * The provider, model, and effort a type runs on when neither the caller's nor the base Settings bind it. A second
 * opinion and a review are worth most from another vendor, so a Codex caller asks Claude and every other caller asks
 * Codex. Computer use runs on Codex, whose bundled Computer Use plugin drives Chrome and desktop apps. X search runs on
 * Grok, the only hosted Agent with native real-time X search.
 *
 * The models and efforts are the ones dianjiang's `review`, `second-opinion`, `operate-desktop`, and `search-twitter`
 * presets settled on in use, so a type works as well out of the box as the preset it replaced: a review at `high` stays
 * fast on large diffs, a second opinion is worth `xhigh` because it is asked for only on an expensive call, and
 * computer use and X search need speed more than depth. Update them when a provider's recommended model moves on.
 *
 * @see https://github.com/tjx666/dianjiang
 */
export function defaultDelegationTypeBinding(
    type: DelegationType,
    caller: z.infer<typeof delegationProviderSchema> | undefined,
): {
    provider: z.infer<typeof delegationProviderSchema>;
    model: string;
    effort: z.infer<typeof delegationEffortSchema>;
} {
    switch (type) {
        case 'computer-use':
            return { provider: 'codex', model: 'gpt-6.1-terra', effort: 'medium' };
        case 'x-search':
            return { provider: 'grok', model: 'grok-4.7', effort: 'medium' };
        case 'review':
            return caller === 'codex'
                ? { provider: 'claude', model: 'sonnet', effort: 'xhigh' }
                : { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' };
        case 'second-opinion':
            return caller === 'codex'
                ? { provider: 'claude', model: 'opus', effort: 'high' }
                : { provider: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' };
    }
}

export const delegationSelectionSchema = z.strictObject({
    ...selectionShape,
    preset: delegationPresetNameSchema.optional(),
    type: delegationTypeSchema.optional(),
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
/**
 * Which Agent runs a {@link DelegationType}. Replaces the whole provider/model/effort tuple, like a caller binding.
 */
const typeBindingSchema = z.strictObject(selectionShape);
const typeBindingsSchema = z.partialRecord(delegationTypeSchema, typeBindingSchema);
const callerSchema = z.strictObject({
    presets: z.record(delegationPresetNameSchema, bindingSchema).optional(),
    /**
     * This caller's own binding per type, ahead of the base `types`.
     */
    types: typeBindingsSchema.optional(),
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
        /**
         * The base binding per type; an unbound type runs on {@link defaultDelegationTypeBinding}.
         */
        types: typeBindingsSchema.default({}),
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
        /**
         * Whether a Session the user took over goes back to the Agent that delegated it once the user has left it
         * alone: no window shows it and no phone watches it for `AUTO_HAND_BACK_AFTER_MS`, its Agent is idle, and the
         * delegating Agent still runs. Off leaves every hand-back to the user.
         */
        autoHandBack: z.boolean().default(true),
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
        const checkTypes = (
            bindings: z.infer<typeof typeBindingsSchema> | undefined,
            path: Array<string | number>,
        ) => {
            const entries = Object.entries(bindings ?? {});
            for (const [type, binding] of entries)
                if (!isDelegationEffortSupported(binding.provider, binding.model, binding.effort))
                    issue(`Unsupported effort for delegation type ${type}`, 'unsupported_effort', [
                        ...path,
                        type,
                        'effort',
                    ]);
        };
        checkTypes(settings.types, ['types']);
        for (const [provider, caller] of Object.entries(settings.callers)) {
            checkTypes(caller.types, ['callers', provider, 'types']);
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
        types: {},
        callers: {},
        readChildChat: true,
        approval: true,
        autoHandBack: true,
    });

export const delegationRosterSchema = z.strictObject({
    maxDepth: z.number().int().min(MIN_DELEGATION_DEPTH).max(MAX_DELEGATION_DEPTH),
    presets: z
        .array(delegationPresetSchema.omit({ instructions: true }))
        .max(MAX_DELEGATION_PRESETS),
    /**
     * The Agent each {@link DelegationType} runs on for this caller, after the caller's and base bindings.
     */
    types: z.array(
        z.strictObject({
            ...selectionShape,
            type: delegationTypeSchema,
        }),
    ),
    prepend: instructionsSchema.optional(),
    append: instructionsSchema.optional(),
});

export type AgentDelegationSettings = z.infer<typeof agentDelegationSettingsSchema>;
export type DelegationSelection = z.infer<typeof delegationSelectionSchema>;
export type DelegationRoster = z.infer<typeof delegationRosterSchema>;

/**
 * Why a task failed or stopped, as a closed enum a Client words itself. Lives with the settings leaf so the history
 * contract can use it without importing the delegation contract that registers it.
 */
export const agentDelegationFailureSchema = z.enum([
    'rate_limited',
    'authentication_failed',
    'output_limit',
    'startup_not_ready',
    /**
     * With status `blocked`: the Agent process is alive but has not started its turn after the startup deadline,
     * usually because a first-run prompt (folder trust, sign-in, an update notice) waits for the user in its Terminal.
     * The task resumes on its own once the Agent starts; the prompt's content is never read.
     */
    'startup_waiting',
    'submission_unconfirmed',
    'provider_failed',
    'permission_required',
    'target_changed',
    'session_changed',
    'human_input',
    'host_reset',
    'result_missing',
    'payload_overflow',
    'launch_failed',
    /**
     * A visible child that runs in a Terminal needs its provider's lifecycle hooks to report the task, and they are off
     * (`agents.providers.<provider>.hooks.enabled`). Nothing was launched.
     */
    'hooks_required',
    'correlation_missing',
    'quota_exhausted',
    'caller_stopped',
    'target_not_ready',
    'target_busy',
    /**
     * Caxri already runs as many live Terminals as it supports (globally or in the target Session), so the child never
     * started. Closing an idle Session or Agent frees a slot; nothing was launched.
     */
    'capacity_exhausted',
]);

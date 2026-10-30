import { z } from 'zod';

export const MAX_AGENT_ACTIONS = 256;
const MAX_AGENT_ACTION_INVOCATION_LENGTH = 128;
export const MAX_AGENT_ACTION_DESCRIPTION_LENGTH = 240;
export const MAX_RECENT_AGENT_ACTIONS = 8;
const AGENT_ACTION_RECENT_VERSION = 1;

const hasControlOrWhitespace = (value: string): boolean =>
    [...value].some((character) => {
        const code = character.codePointAt(0)!;
        return code === 127 || code <= 32;
    });

/**
 * Exact text written to an Agent Terminal. Keeping the prefix in the key lets one settings record override a curated or
 * discovered item without Caxri having to infer whether the provider expects `/` or `$`.
 */
export const agentActionInvocationSchema = z
    .string()
    .min(2)
    .max(MAX_AGENT_ACTION_INVOCATION_LENGTH)
    .refine((value) => value.startsWith('/') || value.startsWith('$'), {
        message: 'Agent action invocation must start with / or $',
    })
    .refine((value) => !hasControlOrWhitespace(value), {
        message: 'Agent action invocation must not contain whitespace or control characters',
    });

const agentActionOverrideSchema = z.strictObject({
    enabled: z.boolean().default(true),
    description: z.string().trim().min(1).max(MAX_AGENT_ACTION_DESCRIPTION_LENGTH).optional(),
    argumentHint: z.string().trim().min(1).max(120).optional(),
});

export const agentActionRecentSettingsSchema = z.strictObject({
    version: z.literal(AGENT_ACTION_RECENT_VERSION),
    invocations: z
        .array(agentActionInvocationSchema)
        .max(MAX_RECENT_AGENT_ACTIONS)
        .refine((value) => new Set(value).size === value.length, {
            message: 'Recent Agent action invocations must be unique',
        }),
});

const defaultAgentActionRecentSettings: z.infer<typeof agentActionRecentSettingsSchema> = {
    version: AGENT_ACTION_RECENT_VERSION,
    invocations: [],
};

const agentActionItemsSchema = z
    .record(agentActionInvocationSchema, agentActionOverrideSchema)
    .refine((value) => Object.keys(value).length <= MAX_AGENT_ACTIONS, {
        message: `Agent actions support at most ${MAX_AGENT_ACTIONS} overrides`,
    })
    .default({});

export const agentActionsSettingsSchema = z
    .object({
        items: agentActionItemsSchema,
        recent: agentActionRecentSettingsSchema.default(defaultAgentActionRecentSettings),
    })
    .default({ items: {}, recent: defaultAgentActionRecentSettings });

export const defaultAgentActionsSettings: z.infer<typeof agentActionsSettingsSchema> = {
    items: {},
    recent: defaultAgentActionRecentSettings,
};

/**
 * User-authored Settings may outlive this private MRU representation. A damaged or unknown history is discarded without
 * rejecting unrelated Agent settings; the canonical wire schema above remains strict.
 */
export const agentActionsSettingsFileSchema = z
    .object({
        items: agentActionItemsSchema,
        recent: agentActionRecentSettingsSchema
            // eslint-disable-next-line unicorn/prefer-await -- Zod's synchronous fallback combinator.
            .catch(defaultAgentActionRecentSettings)
            .default(defaultAgentActionRecentSettings),
    })
    .default(defaultAgentActionsSettings);

/**
 * Records only the bounded action identity. Terminal input, arguments, and transcript content never enter Settings.
 */
export function pushRecentAgentAction(
    settings: AgentActionsSettings,
    invocation: string,
): AgentActionsSettings {
    const validatedInvocation = agentActionInvocationSchema.parse(invocation);
    return {
        ...settings,
        recent: {
            version: AGENT_ACTION_RECENT_VERSION,
            invocations: [
                validatedInvocation,
                ...settings.recent.invocations.filter(
                    (candidate) => candidate !== validatedInvocation,
                ),
            ].slice(0, MAX_RECENT_AGENT_ACTIONS),
        },
    };
}

/**
 * Reconciles retained identities against the currently available catalog without deleting temporarily unavailable or
 * disabled entries from persisted history.
 */
export function resolveRecentAgentActions<T extends { invocation: string }>(
    actions: readonly T[],
    settings: AgentActionsSettings,
): T[] {
    const actionsByInvocation = new Map(actions.map((action) => [action.invocation, action]));
    return settings.recent.invocations.flatMap((invocation) => {
        const action = actionsByInvocation.get(invocation);
        return action ? [action] : [];
    });
}

export type AgentActionOverride = z.infer<typeof agentActionOverrideSchema>;
export type AgentActionRecentSettings = z.infer<typeof agentActionRecentSettingsSchema>;
export type AgentActionsSettings = z.infer<typeof agentActionsSettingsSchema>;

import { z } from 'zod';

export const MAX_AGENT_ACTIONS = 256;
export const MAX_AGENT_ACTION_INVOCATION_LENGTH = 128;
export const MAX_AGENT_ACTION_DESCRIPTION_LENGTH = 240;

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

export const agentActionOverrideSchema = z.strictObject({
    enabled: z.boolean().default(true),
    description: z.string().trim().min(1).max(MAX_AGENT_ACTION_DESCRIPTION_LENGTH).optional(),
    argumentHint: z.string().trim().min(1).max(120).optional(),
});

export const agentActionsSettingsSchema = z
    .object({
        items: z
            .record(agentActionInvocationSchema, agentActionOverrideSchema)
            .refine((value) => Object.keys(value).length <= MAX_AGENT_ACTIONS, {
                message: `Agent actions support at most ${MAX_AGENT_ACTIONS} overrides`,
            })
            .default({}),
    })
    .default({ items: {} });

export type AgentActionOverride = z.infer<typeof agentActionOverrideSchema>;
export type AgentActionsSettings = z.infer<typeof agentActionsSettingsSchema>;

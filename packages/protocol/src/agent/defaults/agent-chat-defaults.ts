import { z } from 'zod';

import { commandPolicy } from '../../transport/method-spec.js';
import { agentChatEffortSchema, agentChatModelSchema } from '../agent-chat-models.js';

/**
 * The Agents whose global model default Caxri reads from and writes to the Agent's own config file: Claude Code's user
 * `settings.json` and Codex's `config.toml`.
 */
export const agentChatDefaultsProviders = ['claude', 'codex'] as const;

export type AgentChatDefaultsProvider = (typeof agentChatDefaultsProviders)[number];

export const agentChatDefaultsProviderSchema = z.enum(agentChatDefaultsProviders);

/**
 * A default key a higher layer than the Agent's config file decides, so a new Chat does not use the file's value.
 * `launchArgs` is Settings › Agents › Initial arguments; `environment` is a variable the Agent reads at launch.
 */
const agentChatDefaultOverrideSchema = z.strictObject({
    key: z.enum(['model', 'effort', 'ultracode']),
    source: z.enum(['launchArgs', 'environment']),
    value: z.string().max(200),
});

export type AgentChatDefaultOverride = z.infer<typeof agentChatDefaultOverrideSchema>;

/**
 * An Agent's global model default as Settings shows it. `model`, `effort`, and `ultracode` are what the Agent's own
 * config file says (absent when it says nothing, so the Agent's built-in default applies); `overrides` names the keys a
 * launch argument or environment variable decides instead.
 */
const agentChatDefaultsSchema = z.strictObject({
    provider: agentChatDefaultsProviderSchema,
    model: agentChatModelSchema.shape.id.optional(),
    effort: agentChatEffortSchema.optional(),
    ultracode: z.boolean().optional(),
    overrides: z.array(agentChatDefaultOverrideSchema).max(6),
    /**
     * Models to choose from: the Agent's own list when it can be read without a Chat, otherwise the list a Chat of this
     * Agent reported last. Empty when neither exists yet.
     */
    models: z.array(agentChatModelSchema).max(50),
    /**
     * The listed model a new Chat runs when no layer names one: Claude Code's `default` alias, or the model Codex marks
     * as the account's default. Settings offers its efforts while the model is left to the Agent.
     */
    builtInModel: agentChatModelSchema.shape.id.optional(),
    /**
     * The config file, with the home directory shown as `~`.
     */
    file: z.string().max(4_096),
});

export type AgentChatDefaults = z.infer<typeof agentChatDefaultsSchema>;

/**
 * Settings › Agents › Default model: an Agent's global model default, kept in the Agent's own config file.
 */
export const agentChatDefaultsMethods = {
    /**
     * Reads an Agent's global model default from its own config file, with the launch settings that override it.
     */
    'agentChat.readDefaults': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({ provider: agentChatDefaultsProviderSchema }),
        result: agentChatDefaultsSchema,
    },
    /**
     * Writes an Agent's global model default to its own config file, merging only these keys; `null` removes a key so
     * the Agent's built-in default applies. Open Chats keep their current choice; new Chats, and a Chat whose choice is
     * reset, use the new default.
     */
    'agentChat.writeDefaults': {
        ...commandPolicy('server', 'write'),
        params: z
            .strictObject({
                provider: agentChatDefaultsProviderSchema,
                model: agentChatModelSchema.shape.id.nullable().optional(),
                effort: agentChatEffortSchema.nullable().optional(),
                ultracode: z.boolean().nullable().optional(),
            })
            .refine(
                (change) =>
                    change.model !== undefined ||
                    change.effort !== undefined ||
                    change.ultracode !== undefined,
                { message: 'Choose a model, an effort, or ultracode' },
            ),
        result: agentChatDefaultsSchema,
    },
};

import type { TranslationParameters } from '../configuration/i18n-interpolate.js';
import { interpolate } from '../configuration/i18n-interpolate.js';
import { agentChatLabelsEn } from './agent-chat-labels-en.js';

/**
 * A key of the shared Agent Chat presentation catalog ({@link agentChatLabelsEn}).
 */
export type AgentChatLabelKey = keyof typeof agentChatLabelsEn;

/**
 * Translates a catalog key in the reader's language. Desktop and the phone pass their own `t`, whose dictionaries
 * spread the catalog; a client's wider key union still satisfies this narrower parameter.
 */
export type AgentChatLabelTranslate = (
    key: AgentChatLabelKey,
    parameters?: TranslationParameters,
) => string;

/**
 * The English translator every presentation function defaults to, so the CLI, Server Core, and tests that pass no `t`
 * keep reading the English source text.
 */
export const translateAgentChatLabel: AgentChatLabelTranslate = (key, parameters) =>
    interpolate(agentChatLabelsEn[key], parameters);

/**
 * Whether a key assembled at runtime (a provider and mode pair) exists in the catalog.
 */
export const isAgentChatLabelKey = (key: string): key is AgentChatLabelKey =>
    Object.hasOwn(agentChatLabelsEn, key);

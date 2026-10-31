import { z } from 'zod';

import {
    MAX_AGENT_CHAT_WEB_SOURCE_TITLE_LENGTH,
    MAX_AGENT_CHAT_WEB_SOURCE_URL_LENGTH,
    MAX_AGENT_CHAT_WEB_SOURCES,
} from '../agent-chat-limits.js';

/**
 * One web page a tool searched or fetched: its address and, when the result named it, its title.
 */
const agentChatWebSourceSchema = z.strictObject({
    url: z.string().min(1).max(MAX_AGENT_CHAT_WEB_SOURCE_URL_LENGTH),
    title: z.string().max(MAX_AGENT_CHAT_WEB_SOURCE_TITLE_LENGTH).optional(),
});

export type AgentChatWebSource = z.infer<typeof agentChatWebSourceSchema>;

/**
 * A tool call's `sources`: the web pages a web tool searched or fetched, in result order, as Server Core read them off
 * the whole result before `output` kept only its tail. A Client lists a turn's pages as the reply's sources, as the
 * ChatGPT app does. Absent for any other tool, or a web tool whose result named no page.
 */
export const agentChatWebSourcesSchema = z
    .array(agentChatWebSourceSchema)
    .max(MAX_AGENT_CHAT_WEB_SOURCES);

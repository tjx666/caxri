import { z } from 'zod';

/**
 * Upper bound of the model requests a context report replays. Claude Code writes one record per request, so a long
 * conversation's transcript tail rarely holds more than this.
 */
export const MAX_AGENT_CHAT_CONTEXT_REQUESTS = 1_000;

/**
 * Upper bound of the context changes a live Chat remembers between reports.
 */
export const MAX_AGENT_CHAT_CONTEXT_CHANGES = 100;

const tokens = z.number().int().nonnegative();
const count = z.number().int().nonnegative();
const epochMs = z.number().int().nonnegative();
const itemName = z.string().min(1).max(200);
const sourceName = z.string().min(1).max(80);
const modelName = z.string().min(1).max(200);
const toolName = z.string().min(1).max(300);
const filePath = z.string().min(1).max(4096);

/**
 * One row of Claude Code's `/context` categories. `kind` says what the row is: `used` content occupies the window,
 * `buffer` is the compaction reserve, `free` is what remains, and `deferred` tool schemas load on demand and sit
 * outside the window until then.
 */
const agentChatContextCategorySchema = z.strictObject({
    label: sourceName,
    tokens,
    kind: z.enum(['used', 'buffer', 'free', 'deferred']),
});

const agentChatContextToolMessagesSchema = z.strictObject({
    name: itemName,
    callTokens: tokens,
    resultTokens: tokens,
});

const agentChatContextAttachmentKindSchema = z.strictObject({ name: itemName, tokens });

const agentChatContextMemoryFileSchema = z.strictObject({
    path: filePath,
    /**
     * The provider's label for where the file comes from, such as `User`, `Project`, or `AutoMem`.
     */
    type: sourceName,
    tokens,
});

const agentChatContextSkillSchema = z.strictObject({
    name: itemName,
    /**
     * Raw source identifier, such as `userSettings`, `projectSettings`, or `plugin`.
     */
    source: sourceName,
    tokens,
});

const agentChatContextMcpToolSchema = z.strictObject({
    name: toolName,
    server: itemName,
    tokens,
    /**
     * Whether the schema is in the window now; a deferred tool loads only when the model searches for it.
     */
    isLoaded: z.boolean(),
});

const agentChatContextAgentSchema = z.strictObject({ type: itemName, source: sourceName, tokens });

const agentChatContextMessagesSchema = z.strictObject({
    toolCalls: tokens,
    toolResults: tokens,
    attachments: tokens,
    assistant: tokens,
    user: tokens,
    /**
     * Messages the provider could not attribute to one of the kinds above, including context redirected from elsewhere.
     */
    other: tokens,
    tools: z.array(agentChatContextToolMessagesSchema).max(200),
    attachmentKinds: z.array(agentChatContextAttachmentKindSchema).max(100),
});

/**
 * What fills a Chat's context right now, item by item: the structured twin of Claude Code's `/context`. Token counts
 * are the provider's local estimates, not a billed count.
 */
export const agentChatContextCompositionSchema = z.strictObject({
    model: modelName.optional(),
    totalTokens: tokens,
    /**
     * The window usage is measured against: the autocompact window when it is smaller than the model's own.
     */
    window: tokens,
    /**
     * Total past which the provider compacts on its own; absent when it does not say.
     */
    autoCompactThreshold: tokens.optional(),
    isAutoCompactEnabled: z.boolean(),
    categories: z.array(agentChatContextCategorySchema).max(32),
    memoryFiles: z.array(agentChatContextMemoryFileSchema).max(200),
    skills: z
        .strictObject({
            total: count,
            included: count,
            tokens,
            items: z.array(agentChatContextSkillSchema).max(500),
        })
        .optional(),
    mcpTools: z.array(agentChatContextMcpToolSchema).max(1_000),
    agents: z.array(agentChatContextAgentSchema).max(200),
    slashCommands: z.strictObject({ total: count, included: count, tokens }).optional(),
    messages: agentChatContextMessagesSchema.optional(),
});

/**
 * One model request of the main conversation as its usage reports it. The prompt is `input + cacheRead + cacheWrite`; a
 * request that reads less of the cache than the previous prompt held is where the cache broke.
 */
export const agentChatContextRequestSchema = z.strictObject({
    at: epochMs,
    model: modelName.optional(),
    input: tokens,
    cacheRead: tokens,
    cacheWrite: tokens,
    output: tokens,
    /**
     * Lifetime the request wrote its cache entries with, when it wrote any.
     */
    cacheTtlMinutes: z.union([z.literal(5), z.literal(60)]).optional(),
    /**
     * Estimated standard API price of the cache write, in US dollars. Absent when the model is not in the price list.
     */
    cacheWriteUsd: z.number().nonnegative().optional(),
    /**
     * The first request after the conversation was compacted, which rewrites the cache by design.
     */
    afterCompaction: z.boolean().optional(),
});

/**
 * A change to what precedes the conversation in every request (tools, system prompt, memory, skills), noticed between
 * two context reads of a live Chat. Any such change invalidates the prompt cache from where it sits onward.
 */
export const agentChatContextChangeSchema = z.strictObject({
    at: epochMs,
    kind: z.enum([
        'mcpToolsAdded',
        'mcpToolsRemoved',
        'skillsAdded',
        'skillsRemoved',
        'agentsChanged',
        'memoryChanged',
        'systemPromptChanged',
        'systemToolsChanged',
    ]),
    /**
     * Tool, skill, or agent names, or memory file paths; bounded like a path so a deep `CLAUDE.md` fits.
     */
    names: z.array(filePath).max(50),
    /**
     * Signed token difference of a change that has no names, such as a longer system prompt.
     */
    tokenDelta: z.number().int().optional(),
});

/**
 * Everything the Context tab shows about one Chat: what fills the window and how the prompt cache held up request by
 * request. See `docs/agent-chat.md`.
 */
export const agentChatContextReportSchema = z.strictObject({
    generatedAt: epochMs,
    /**
     * Absent while the provider process is not running or did not answer in time.
     */
    composition: agentChatContextCompositionSchema.optional(),
    requests: z.array(agentChatContextRequestSchema).max(MAX_AGENT_CHAT_CONTEXT_REQUESTS),
    /**
     * Whether older requests exist than the report replays: the transcript tail it reads was cut.
     */
    isHistoryTruncated: z.boolean(),
    changes: z.array(agentChatContextChangeSchema).max(MAX_AGENT_CHAT_CONTEXT_CHANGES),
});

export type AgentChatContextComposition = z.infer<typeof agentChatContextCompositionSchema>;
export type AgentChatContextRequest = z.infer<typeof agentChatContextRequestSchema>;
export type AgentChatContextChange = z.infer<typeof agentChatContextChangeSchema>;
export type AgentChatContextReport = z.infer<typeof agentChatContextReportSchema>;

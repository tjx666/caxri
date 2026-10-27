/* eslint-disable unicorn/max-nested-calls -- Declarative Zod schemas intentionally compose bounded validators inline. */
import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import { agentChatCommandSchema, MAX_AGENT_CHAT_COMMANDS } from './agent-chat-commands.js';
import { agentChatGoalSchema } from './agent-chat-goal-contract.js';
import {
    MAX_AGENT_CHAT_DIFF_LENGTH,
    MAX_AGENT_CHAT_FILE_CHANGES,
    MAX_AGENT_CHAT_IMAGES,
    MAX_AGENT_CHAT_ITEMS,
    MAX_AGENT_CHAT_MESSAGE_LENGTH,
    MAX_AGENT_CHAT_MODELS,
    MAX_AGENT_CHAT_OUTPUT_LENGTH,
    MAX_AGENT_CHAT_PLAN_STEPS,
    MAX_AGENT_CHAT_QUEUE,
    MAX_AGENT_CHAT_TASKS,
    MAX_AGENT_CHAT_TEXT_LENGTH,
    MAX_AGENT_CHAT_THUMBNAIL_LENGTH,
} from './agent-chat-limits.js';
import { agentChatMcpServerSchema, MAX_AGENT_CHAT_MCP_SERVERS } from './agent-chat-mcp.js';
import { agentChatPermissionModeSchema } from './agent-chat-permissions.js';
import { agentChatRequestSchema, MAX_AGENT_CHAT_QUESTIONS } from './agent-chat-requests.js';
import {
    agentChatGoalUsageSchema,
    agentChatTurnUsageSchema,
    agentChatUsageSchema,
} from './agent-chat-usage.js';
import {
    agentChatUsageGuardSchema,
    agentChatUsageLimitSchema,
} from './agent-usage-continuation.js';
import { agentChatDelegatedTaskSchema } from './delegation/agent-delegated-task.js';

const boundedText = z.string().max(MAX_AGENT_CHAT_TEXT_LENGTH);
const boundedOutput = z.string().max(MAX_AGENT_CHAT_OUTPUT_LENGTH);

export const agentChatImageMediaTypeSchema = z.enum([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
]);

/**
 * Only an inline base64 raster image may be rendered, so a provider or Client cannot make the Renderer load a remote
 * URL through a thumbnail.
 */
export const agentChatThumbnailSchema = z
    .string()
    .max(MAX_AGENT_CHAT_THUMBNAIL_LENGTH)
    .regex(/^data:image\/(?:png|jpeg|gif|webp);base64,[\d+/A-Za-z]+={0,2}$/u);

/**
 * An image attached to a user message. `thumbnail` is absent when the provider's history carries the image but no
 * preview Caxri made, such as a resumed conversation; the Chat then shows a placeholder.
 */
export const agentChatImageReferenceSchema = z.strictObject({
    thumbnail: agentChatThumbnailSchema.optional(),
});

/**
 * A reasoning effort level, as the provider names it (`low`, `high`, `xhigh`, ...). Kept open because each provider and
 * model offers its own set.
 */
export const agentChatEffortSchema = z
    .string()
    .min(1)
    .max(40)
    .regex(/^[\w-]+$/u);

/**
 * A model the provider lets this Chat switch to, with the reasoning efforts it accepts.
 */
export const agentChatModelSchema = z.strictObject({
    /**
     * The identifier the provider takes when switching, and reports as the snapshot's `model` once it is in use.
     */
    id: z.string().min(1).max(200),
    displayName: z.string().max(200),
    description: z.string().max(500).optional(),
    /**
     * Another identifier the provider reports for this model, such as the full model a Claude Code alias resolves to,
     * so the snapshot's `model` still matches the row it was chosen from.
     */
    resolvedId: z.string().max(200).optional(),
    /**
     * Efforts the model accepts, lowest first. Empty for a model without effort control.
     */
    efforts: z.array(agentChatEffortSchema).max(10),
    defaultEffort: agentChatEffortSchema.optional(),
    /**
     * Present when the model offers Fast mode: faster output at a higher usage cost (Codex's `priority` service tier,
     * Claude Code's `fastMode`). `description` is the provider's own wording, such as Codex's `1.5x speed, increased
     * usage`.
     */
    fast: z.strictObject({ description: z.string().max(200).optional() }).optional(),
});

/**
 * Lifecycle of one structured tool-like item. `interrupted` is Caxri's own closure for an item the provider left open
 * when its turn ended.
 */
export const agentChatItemStatusSchema = z.enum([
    'running',
    'completed',
    'failed',
    'declined',
    'interrupted',
]);

const itemBase = {
    id: z.string().min(1).max(200),
    turnId: z.string().min(1).max(200).optional(),
    /**
     * When the item entered the conversation, in epoch milliseconds. Server Core stamps a live item the first time it
     * reaches the projection, and the shared reducer carries the stamp across later upserts of the same id. A replayed
     * history item carries only the time its provider recorded, so it is absent when the provider kept none.
     */
    createdAt: z.number().int().nonnegative().optional(),
};

const noticeName = z.string().min(1).max(100);

/**
 * A provider feedback notice's heading (see the notice item's `heading`).
 */
export const agentChatNoticeHeadingSchema = z.discriminatedUnion('kind', [
    /**
     * A slash command's output, named by the plugin and command that produced it when the provider reports them.
     */
    z.strictObject({
        kind: z.literal('command'),
        plugin: noticeName.optional(),
        command: noticeName.optional(),
    }),
    /**
     * A Hook that failed, blocked an action, or stopped the turn. `session` marks a Hook the Session's settings
     * configured rather than one a plugin or the turn added.
     */
    z.strictObject({
        kind: z.literal('hook'),
        outcome: z.enum(['failed', 'blocked', 'stopped']),
        hook: noticeName,
        session: z.boolean().optional(),
        exitCode: z.number().int().optional(),
    }),
    /**
     * A message the provider itself raised, worded by what it is about.
     */
    z.strictObject({
        kind: z.literal('provider'),
        provider: z.enum(['claude', 'codex']),
        topic: z.enum(['warning', 'error', 'configuration', 'deprecation']),
    }),
    /**
     * `caxriNote` is a note Caxri itself sent the Agent, such as that the user stopped a subagent.
     */
    z.strictObject({
        kind: z.literal('event'),
        event: z.enum([
            'inputBlocked',
            'modelDeclined',
            'modelChanged',
            'verificationNeeded',
            'caxriNote',
        ]),
    }),
]);

export type AgentChatNoticeHeading = z.infer<typeof agentChatNoticeHeadingSchema>;

export const agentChatItemSchema = z.discriminatedUnion('type', [
    z.strictObject({
        ...itemBase,
        type: z.literal('userMessage'),
        text: boundedText,
        images: z.array(agentChatImageReferenceSchema).max(MAX_AGENT_CHAT_IMAGES).optional(),
        /**
         * How a message sent while a turn ran reached the Agent: `steered` into the running turn, or `queued` and sent
         * once the turn ended. Absent for a message that started a turn directly.
         */
        delivery: z.enum(['steered', 'queued']).optional(),
        /**
         * Set by Server Core when `text` is a delegated task pointer rather than something the user typed.
         */
        delegatedTask: agentChatDelegatedTaskSchema.optional(),
    }),
    z.strictObject({
        ...itemBase,
        type: z.literal('agentMessage'),
        text: boundedText,
        /**
         * True while deltas may still append to `text`.
         */
        streaming: z.boolean(),
    }),
    z.strictObject({
        ...itemBase,
        type: z.literal('reasoning'),
        text: boundedText,
        streaming: z.boolean(),
    }),
    z.strictObject({
        ...itemBase,
        type: z.literal('command'),
        command: z.string().max(4_096),
        /**
         * What the command does in plain words, when the Agent wrote one (Claude Code's `Bash` description).
         */
        description: z.string().max(500).optional(),
        /**
         * True once the command runs on in the background: started that way, or moved there by the user or a timeout.
         * Its `status` then settles when the Agent hands it off, so `exitCode` and `durationMs` stay absent.
         */
        background: z.boolean().optional(),
        status: agentChatItemStatusSchema,
        /**
         * Bounded tail of the combined command output.
         */
        output: boundedOutput,
        exitCode: z.number().int().optional(),
        durationMs: z.number().nonnegative().optional(),
    }),
    z.strictObject({
        ...itemBase,
        type: z.literal('fileChange'),
        status: agentChatItemStatusSchema,
        changes: z
            .array(
                z.strictObject({
                    path: z.string().max(4_096),
                    kind: z.enum(['add', 'delete', 'update']),
                    diff: z.string().max(MAX_AGENT_CHAT_DIFF_LENGTH),
                    /**
                     * Set when Server Core cut this diff to `MAX_AGENT_CHAT_DIFF_LENGTH` or to the item's remaining
                     * `MAX_AGENT_CHAT_FILE_CHANGE_DIFF_TOTAL` budget, so a Client can say where the diff stops instead
                     * of presenting a partial patch as the whole change.
                     */
                    truncated: z.boolean().optional(),
                }),
            )
            .max(MAX_AGENT_CHAT_FILE_CHANGES),
    }),
    z.strictObject({
        ...itemBase,
        type: z.literal('toolCall'),
        /**
         * Provider tool name, such as an MCP `server/tool` pair or `webSearch`.
         */
        name: z.string().max(200),
        status: agentChatItemStatusSchema,
        /**
         * One-line description (a search query or tool arguments preview).
         */
        summary: z.string().max(1_000).optional(),
        /**
         * JSON preview of the arguments, set only when `summary` is a readable digest of them (`to lead: Done` for a
         * `SendMessage`) rather than the arguments themselves. The row title reads `summary`; an expanded row shows
         * this so the full arguments stay inspectable.
         */
        input: z.string().max(1_000).optional(),
        output: boundedOutput.optional(),
        durationMs: z.number().nonnegative().optional(),
    }),
    z.strictObject({
        ...itemBase,
        type: z.literal('notice'),
        /**
         * Closed kind so the Renderer owns the copy for known events. `message` carries provider text for errors and
         * retries, and for `answered` the user's own answers to a question request, so the transcript keeps what was
         * chosen after the request card goes away.
         */
        kind: z.enum(['error', 'warning', 'compacted', 'retrying', 'answered', 'output']),
        /**
         * Provider feedback heading, kept separate from its complete readable details. A closed kind plus the
         * provider's own names, so each Client words it in the reader's language (`agentChatNoticeHeading`); Hook,
         * plugin, and command names stay as the provider wrote them.
         */
        heading: agentChatNoticeHeadingSchema.optional(),
        message: z.string().max(2_000).optional(),
        /**
         * For `compacted`: how large the context was before and after, and whether the user or the provider started it,
         * when the provider reports them (Claude Code's `compact_metadata`) or Caxri can read them off the usage on
         * both sides of the compaction (Codex). `idle` is Caxri's own idle compaction before the prompt cache expired;
         * it is known only to the Server Core that ran it, so a history replayed later reports it as `manual`.
         */
        compaction: z
            .strictObject({
                beforeTokens: z.number().int().nonnegative().optional(),
                afterTokens: z.number().int().nonnegative().optional(),
                trigger: z.enum(['manual', 'auto', 'idle']).optional(),
            })
            .optional(),
        /**
         * For `retrying`: why the provider retries and which attempt this is, so a Client words and marks it without
         * parsing provider text; `message` then carries only the provider's detail. `connection` is a request that got
         * no response at all (a dropped stream, a timeout).
         */
        retry: z
            .strictObject({
                cause: z.enum(['connection', 'rateLimit', 'overloaded', 'server', 'other']),
                attempt: z.number().int().positive().optional(),
                maxAttempts: z.number().int().positive().optional(),
                /**
                 * Set by the shared reducer once the turn made progress after this retry (a later reply, thought, or
                 * tool item), so a Client settles the row into a muted "recovered" line instead of leaving an amber
                 * "retrying" on a healthy turn. A newer retry upsert replaces the notice and clears it.
                 */
                resolved: z.boolean().optional(),
            })
            .optional(),
        /**
         * For `answered`: every question asked with the answer given (empty when the user skipped it), so a Client can
         * list them as the Codex app does instead of the one-line `message` digest, which stays for Clients that show
         * plain text.
         */
        answers: z
            .array(
                z.strictObject({ question: z.string().max(2_000), answer: z.string().max(2_000) }),
            )
            .max(MAX_AGENT_CHAT_QUESTIONS)
            .optional(),
        /**
         * For `error`: the provider failed the turn on a used-up plan limit (`agentChatUsageLimitSchema`).
         */
        usageLimit: agentChatUsageLimitSchema.optional(),
    }),
]);

/**
 * One piece of background work the Agent started: a subagent or a background shell. The Chat lists it so the user can
 * open its own tab (`agentChat.readTask`) and stop it (`agentChat.stopTask`). `id` is Caxri's stable key; `itemId`
 * links the timeline row that started it.
 */
export const agentChatTaskSchema = z.strictObject({
    id: z.string().min(1).max(200),
    kind: z.enum(['agent', 'shell']),
    /**
     * The subagent's description, or for a shell what it does in plain words (Claude Code's `Bash` description) and
     * otherwise its command line. `command` carries the command line when the title is the description.
     */
    title: z.string().max(1_000),
    command: z.string().max(10_000).optional(),
    status: z.enum(['running', 'completed', 'failed', 'stopped']),
    itemId: z.string().min(1).max(200).optional(),
    /**
     * Provider agent type, such as `general-purpose` or a custom agent's name.
     */
    agentType: z.string().max(200).optional(),
    model: z.string().max(200).optional(),
    /**
     * False while a foreground subagent blocks the turn that started it; true once it runs in the background.
     */
    isBackground: z.boolean(),
    startedAt: z.number().optional(),
    endedAt: z.number().optional(),
    /**
     * The provider's one-line progress or final summary.
     */
    summary: z.string().max(2_000).optional(),
    usage: z
        .strictObject({
            totalTokens: z.number().int().nonnegative().optional(),
            toolUses: z.number().int().nonnegative().optional(),
            durationMs: z.number().nonnegative().optional(),
        })
        .optional(),
    lastToolName: z.string().max(200).optional(),
    /**
     * Whether the provider can stop this task on its own, without ending the turn or the Chat.
     */
    canStop: z.boolean(),
});

/**
 * A follow-up message held by Server Core until the running turn ends. Image data stays on Server Core; the Client sees
 * the count.
 */
export const agentChatQueuedMessageSchema = z.strictObject({
    id: z.string().min(1).max(200),
    text: z.string().max(MAX_AGENT_CHAT_MESSAGE_LENGTH),
    imageCount: z.number().int().min(1).max(MAX_AGENT_CHAT_IMAGES).optional(),
    /**
     * Set when the queued input runs a slash command rather than sending a message.
     */
    command: z
        .strictObject({
            name: agentChatCommandSchema.shape.name,
            arguments: z.string().max(MAX_AGENT_CHAT_MESSAGE_LENGTH).optional(),
        })
        .optional(),
});

export const agentChatTurnSchema = z.strictObject({
    id: z.string().min(1).max(200),
    status: z.enum(['running', 'completed', 'interrupted', 'failed']),
    startedAt: z.number().optional(),
    durationMs: z.number().nonnegative().optional(),
    /**
     * Who asked Caxri to stop an `interrupted` turn: the user's Stop, or another Agent through dispatch. Absent when
     * the turn ended some other way (the provider process exited) or the stop predates this Server Core, as in replayed
     * history.
     */
    stoppedBy: z.enum(['user', 'agent', 'usageGuard']).optional(),
    /**
     * What the finished turn produced and cost, recorded once when it ends so its reply can show them. Absent for a
     * turn still running, one replayed from provider history, or a provider that reports neither.
     */
    metrics: z
        .strictObject({
            /**
             * Output tokens over the time the model spent generating them, summed across the turn's responses (tool
             * runs excluded), from the provider's transcript; both absent when it records no timing.
             */
            outputTokens: z.number().int().nonnegative().optional(),
            generationMs: z.number().nonnegative().optional(),
            /**
             * Estimated list-price cost of every response in the turn; absent when a response's model has no price.
             */
            costUsd: z.number().nonnegative().optional(),
        })
        .optional(),
});

export const agentChatPlanSchema = z.strictObject({
    turnId: z.string().max(200),
    explanation: z.string().max(2_000).optional(),
    steps: z
        .array(
            z.strictObject({
                step: z.string().max(1_000),
                status: z.enum(['pending', 'inProgress', 'completed']),
            }),
        )
        .max(MAX_AGENT_CHAT_PLAN_STEPS),
});

/**
 * Why a Chat cannot currently run. Closed so the Renderer maps each to actionable copy; provider text never selects UI.
 */
export const agentChatFailureReasonSchema = z.enum([
    'executable_not_found',
    'spawn_failed',
    'handshake_failed',
    'process_exited',
    'resume_failed',
    /**
     * The bound conversation is open in another client of the same provider (for example the Codex app), which holds
     * its only writer. Closing it there and retrying resumes it here.
     */
    'conversation_in_use',
    'unsupported_version',
]);

export const agentChatStatusSchema = z.enum([
    /**
     * No provider process is running; the next read or message resumes the Agent Session.
     */
    'stopped',
    'starting',
    'ready',
    'failed',
]);

export const agentChatSnapshotSchema = z.strictObject({
    terminalId: identifierSchema,
    /**
     * Increments with every patch. A Client that sees a patch whose `baseRevision` differs from its own copy re-reads.
     */
    revision: z.number().int().nonnegative(),
    status: agentChatStatusSchema,
    failure: z
        .strictObject({
            reason: agentChatFailureReasonSchema,
            detail: z.string().max(300).optional(),
        })
        .optional(),
    /**
     * True when older history exists than `items` holds; `agentChat.readHistory` pages through it.
     */
    truncated: z.boolean(),
    /**
     * Identifies the history `items` continues. Server Core assigns a new one whenever the conversation is replaced
     * (`reset`), so a Client discards older pages it read for a previous history instead of stitching them to this
     * one.
     */
    historyId: z.string().min(1).max(100).optional(),
    items: z.array(agentChatItemSchema).max(MAX_AGENT_CHAT_ITEMS),
    turns: z.array(agentChatTurnSchema).max(MAX_AGENT_CHAT_ITEMS),
    activeTurnId: z.string().max(200).optional(),
    requests: z.array(agentChatRequestSchema).max(20),
    plan: agentChatPlanSchema.optional(),
    /**
     * The goal the provider pursues across turns. Present only for a provider with native goals (Codex, Claude Code)
     * while one is set.
     */
    goal: agentChatGoalSchema.optional(),
    /**
     * The goal's spend across its turns (`agentChatGoalUsageSchema`); a Client shows it only beside the goal it names.
     */
    goalUsage: agentChatGoalUsageSchema.optional(),
    model: z.string().max(200).optional(),
    /**
     * The reasoning effort the next turn uses, when the provider reports it.
     */
    effort: agentChatEffortSchema.optional(),
    /**
     * Claude Code's ultracode: standing multi-agent Workflow orchestration at any effort level. Present only while the
     * provider offers it for the current model; `agentChat.configure` turns it on or off.
     */
    ultracode: z.boolean().optional(),
    /**
     * Whether the next turn runs in Fast mode. Present only while the provider can turn it on for this Chat; the picker
     * offers the toggle when the current model also lists `fast`. `agentChat.configure` turns it on or off.
     */
    fast: z.boolean().optional(),
    /**
     * The permission level the next turn runs with. Absent when the provider's launch settings describe something no
     * level matches (shown as "Custom"); `agentChat.configure` switches it.
     */
    permissionMode: agentChatPermissionModeSchema.optional(),
    /**
     * Whether the next turn plans instead of acting. Present only for a provider with a native plan mode.
     */
    planMode: z.boolean().optional(),
    /**
     * Models `agentChat.configure` can switch to. Absent until the provider has listed them.
     */
    models: z.array(agentChatModelSchema).max(MAX_AGENT_CHAT_MODELS).optional(),
    /**
     * Slash commands the provider currently offers. Absent until the provider has started.
     */
    commands: z.array(agentChatCommandSchema).max(MAX_AGENT_CHAT_COMMANDS).optional(),
    /**
     * MCP servers the Chat's tool calls named, as the provider describes them (display name and icon). Server Core
     * looks a server up the first time a tool call names it, so a server the Chat never called is never listed.
     */
    mcpServers: z.array(agentChatMcpServerSchema).max(MAX_AGENT_CHAT_MCP_SERVERS).optional(),
    usage: agentChatUsageSchema.optional(),
    /**
     * The latest turn's spend so far; a Client shows it only while that turn is the active one.
     */
    turnUsage: agentChatTurnUsageSchema.optional(),
    /**
     * Provider-wide work in progress that is not a turn, such as compacting the context.
     */
    operation: z.enum(['compacting']).optional(),
    tasks: z.array(agentChatTaskSchema).max(MAX_AGENT_CHAT_TASKS).optional(),
    queue: z.array(agentChatQueuedMessageSchema).max(MAX_AGENT_CHAT_QUEUE).optional(),
    /**
     * How many messages the queue really holds. Set on a phone's copy, whose `queue` keeps only the first
     * `MOBILE_AGENT_CHAT_QUEUE_MAX_ITEMS`, so the queue card still counts every waiting message.
     */
    queueLength: z.number().int().nonnegative().max(MAX_AGENT_CHAT_QUEUE).optional(),
    /**
     * True after the user stopped a turn with messages still queued; nothing is sent until they resume the queue.
     */
    queuePaused: z.boolean().optional(),
    /**
     * Why the queue is paused, set together with `queuePaused` and cleared when it resumes or empties: `stopped` after
     * the user interrupted a turn, `sendFailed` after Server Core could not send the queued messages it took, and
     * `deliveryUnknown` after a send may have reached the provider unconfirmed. Clients tell a failure from a Stop by
     * it.
     */
    queuePauseReason: z.enum(['stopped', 'sendFailed', 'deliveryUnknown', 'usageGuard']).optional(),
    /**
     * Set while the provider's account is at the weekly usage guard (`agentChatUsageGuardSchema`).
     */
    usageGuard: agentChatUsageGuardSchema.optional(),
});

export type AgentChatItem = z.infer<typeof agentChatItemSchema>;
export type AgentChatTask = z.infer<typeof agentChatTaskSchema>;
export type AgentChatQueuedMessage = z.infer<typeof agentChatQueuedMessageSchema>;
export type AgentChatItemStatus = z.infer<typeof agentChatItemStatusSchema>;
export type AgentChatTurn = z.infer<typeof agentChatTurnSchema>;
export type AgentChatTurnMetrics = NonNullable<AgentChatTurn['metrics']>;
export type AgentChatPlan = z.infer<typeof agentChatPlanSchema>;
export type AgentChatFailureReason = z.infer<typeof agentChatFailureReasonSchema>;
export type AgentChatStatus = z.infer<typeof agentChatStatusSchema>;
export type AgentChatSnapshot = z.infer<typeof agentChatSnapshotSchema>;
export type AgentChatModel = z.infer<typeof agentChatModelSchema>;
export type AgentChatImageMediaType = z.infer<typeof agentChatImageMediaTypeSchema>;
/* eslint-enable unicorn/max-nested-calls */

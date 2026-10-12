/* eslint-disable unicorn/max-nested-calls -- Declarative Zod schemas intentionally compose bounded validators inline. */
import { z } from 'zod';

import { identifierSchema } from '../domain/domain.js';
import { agentChatPermissionModeSchema } from './agent-chat-permissions.js';
import { agentChatRequestSchema, MAX_AGENT_CHAT_QUESTIONS } from './agent-chat-requests.js';
import { agentChatUsageSchema } from './agent-chat-usage.js';

/**
 * Bounds for one Agent Chat projection. Server Core keeps only the current conversation window in memory; the
 * provider's own record remains the source of truth, so a truncated projection can always be rebuilt by resuming the
 * Agent Session.
 */
export const MAX_AGENT_CHAT_ITEMS = 1_000;
export const MAX_AGENT_CHAT_TEXT_LENGTH = 64 * 1024;
export const MAX_AGENT_CHAT_OUTPUT_LENGTH = 16 * 1024;
export const MAX_AGENT_CHAT_DIFF_LENGTH = 64 * 1024;
export const MAX_AGENT_CHAT_FILE_CHANGES = 100;
/**
 * Sum of every diff in one file-change item, kept well under the aggregate budget below.
 */
export const MAX_AGENT_CHAT_FILE_CHANGE_DIFF_TOTAL = 1024 * 1024;
export const MAX_AGENT_CHAT_PLAN_STEPS = 50;
export const MAX_AGENT_CHAT_MESSAGE_LENGTH = 100_000;
export const MAX_AGENT_CHAT_PATCH_OPERATIONS = 200;
/**
 * Aggregate budget for every item's text. Oldest items are dropped (and `truncated` set) once it is exceeded, so many
 * individually valid items cannot add up to an unbounded snapshot.
 */
export const MAX_AGENT_CHAT_TOTAL_TEXT_LENGTH = 4 * 1024 * 1024;
/**
 * Bounds for one `agentChat.readHistory` page: the items older than what a Client holds, read from the history Server
 * Core keeps beyond the live projection. A page always carries at least one item, so a single large item still pages.
 */
export const MAX_AGENT_CHAT_HISTORY_PAGE_ITEMS = 200;
export const MAX_AGENT_CHAT_HISTORY_PAGE_TEXT_LENGTH = 2 * 1024 * 1024;
/**
 * Images one message may attach. Each is bounded by the smaller per-image limit the hosted providers accept (the
 * Anthropic API's 5 MB), so Caxri rejects an oversized image up front instead of letting the provider fail the turn.
 * The count stops at 20 because the Anthropic API lowers its per-image dimension limit from 8000 to 2000 pixels once a
 * request carries more than 20 images, which would fail an ordinary full-resolution screenshot.
 */
export const MAX_AGENT_CHAT_IMAGES = 20;
export const MAX_AGENT_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
/**
 * Combined bytes of one message's images. It keeps the worst-case payload where four 5 MB images already put it, so a
 * message stays inside the Anthropic API's 32 MB request limit once base64 adds a third, and the Desktop, Server Core,
 * and provider pipes carry no more than they did before the count rose.
 */
export const MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES = 20 * 1024 * 1024;
/**
 * Combined bytes of the images one `dialog.selectPaths` pick reads for the composer. Larger than
 * {@link MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES} because the composer resizes an oversized screenshot under the per-image
 * limit after the pick; an image past what is left of it is cited by path instead.
 */
export const MAX_AGENT_CHAT_PICKED_IMAGES_BYTES = 64 * 1024 * 1024;
/**
 * The default `agentChat.longPasteThreshold`: pasted text longer than this (in UTF-16 code units, what the input
 * counts) is saved to a file the message cites instead of landing in the input, following T3 Code's 32 KiB pasted-text
 * attachment. A paste that would push the message past {@link MAX_AGENT_CHAT_MESSAGE_LENGTH} is saved too, whatever the
 * setting, since the input would otherwise cut it.
 */
export const AGENT_CHAT_LONG_PASTE_THRESHOLD = 32 * 1024;
/**
 * A sent image's preview is a small Renderer-made thumbnail, not the image itself, so the projection stays bounded.
 */
export const MAX_AGENT_CHAT_THUMBNAIL_LENGTH = 48 * 1024;
export const MAX_AGENT_CHAT_COMMANDS = 200;
export const MAX_AGENT_CHAT_MODELS = 50;
/**
 * Background work a Chat lists at once (subagents and background shells). Older ended tasks drop first.
 */
export const MAX_AGENT_CHAT_TASKS = 50;
/**
 * Items one task projection keeps, and its aggregate text budget. A chatty subagent evicts only its own history, never
 * the parent conversation's.
 */
export const MAX_AGENT_CHAT_TASK_ITEMS = 500;
export const MAX_AGENT_CHAT_TASK_TOTAL_TEXT_LENGTH = 512 * 1024;
/**
 * Follow-up messages a Chat holds while a turn runs, and their combined text, so the queue cannot grow without bound.
 */
export const MAX_AGENT_CHAT_QUEUE = 20;
export const MAX_AGENT_CHAT_QUEUE_TEXT_LENGTH = 256 * 1024;

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
 * A slash command the provider runs. The list is the provider's own (Claude Code reports its commands, Codex has a
 * fixed set Caxri maps to app-server methods), so a command that is not listed is never offered.
 */
export const agentChatCommandSchema = z.strictObject({
    name: z
        .string()
        .min(1)
        .max(100)
        .regex(/^[\w:.-]+$/u),
    description: z.string().max(500).optional(),
    /**
     * Placeholder for the command's arguments, such as `<file>`. A command without one runs as soon as it is chosen.
     */
    argumentHint: z.string().max(200).optional(),
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
        kind: z.enum(['error', 'compacted', 'retrying', 'answered']),
        message: z.string().max(2_000).optional(),
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
    usage: agentChatUsageSchema.optional(),
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
    queuePauseReason: z.enum(['stopped', 'sendFailed', 'deliveryUnknown']).optional(),
});

/**
 * One incremental change. `upsertItem` replaces an item by id (appending when new); `appendText` streams a delta into a
 * message, reasoning, or command output; `state` replaces the scalar parts of the snapshot that changed.
 */
export const agentChatPatchOperationSchema = z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('upsertItem'), item: agentChatItemSchema }),
    z.strictObject({
        op: z.literal('appendText'),
        itemId: z.string().min(1).max(200),
        delta: z.string().max(MAX_AGENT_CHAT_TEXT_LENGTH),
    }),
    z.strictObject({
        op: z.literal('state'),
        /**
         * Present keys replace their snapshot value; `null` clears an optional one (JSON cannot carry `undefined`).
         */
        state: z
            .strictObject({
                status: agentChatSnapshotSchema.shape.status,
                failure: agentChatSnapshotSchema.shape.failure.unwrap().nullable(),
                turns: agentChatSnapshotSchema.shape.turns,
                activeTurnId: agentChatSnapshotSchema.shape.activeTurnId.unwrap().nullable(),
                requests: agentChatSnapshotSchema.shape.requests,
                plan: agentChatSnapshotSchema.shape.plan.unwrap().nullable(),
                model: agentChatSnapshotSchema.shape.model.unwrap().nullable(),
                effort: agentChatSnapshotSchema.shape.effort.unwrap().nullable(),
                ultracode: agentChatSnapshotSchema.shape.ultracode.unwrap().nullable(),
                fast: agentChatSnapshotSchema.shape.fast.unwrap().nullable(),
                permissionMode: agentChatSnapshotSchema.shape.permissionMode.unwrap().nullable(),
                planMode: agentChatSnapshotSchema.shape.planMode.unwrap().nullable(),
                models: agentChatSnapshotSchema.shape.models.unwrap(),
                commands: agentChatSnapshotSchema.shape.commands.unwrap(),
                usage: agentChatSnapshotSchema.shape.usage.unwrap().nullable(),
                truncated: agentChatSnapshotSchema.shape.truncated,
                historyId: agentChatSnapshotSchema.shape.historyId.unwrap(),
                operation: agentChatSnapshotSchema.shape.operation.unwrap().nullable(),
                tasks: agentChatSnapshotSchema.shape.tasks.unwrap(),
                queue: agentChatSnapshotSchema.shape.queue.unwrap(),
                queueLength: agentChatSnapshotSchema.shape.queueLength.unwrap(),
                queuePaused: agentChatSnapshotSchema.shape.queuePaused.unwrap(),
                queuePauseReason: agentChatSnapshotSchema.shape.queuePauseReason
                    .unwrap()
                    .nullable(),
            })
            .partial(),
    }),
    z.strictObject({ op: z.literal('reset') }),
]);

/**
 * One page of older history: the items right before the Client's oldest one, oldest first, with the turns they belong
 * to. `hasMore` asks for the next page with this page's oldest item; once it is false, `truncated` says whether the
 * conversation still goes back further than Chat can show (the provider's record is the only full copy).
 */
export const agentChatHistoryPageSchema = z.strictObject({
    historyId: agentChatSnapshotSchema.shape.historyId.unwrap(),
    items: z.array(agentChatItemSchema).max(MAX_AGENT_CHAT_HISTORY_PAGE_ITEMS),
    turns: z.array(agentChatTurnSchema).max(MAX_AGENT_CHAT_HISTORY_PAGE_ITEMS),
    hasMore: z.boolean(),
    truncated: z.boolean(),
});

export const agentChatPatchSchema = z.strictObject({
    terminalId: identifierSchema,
    baseRevision: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    operations: z.array(agentChatPatchOperationSchema).min(1).max(MAX_AGENT_CHAT_PATCH_OPERATIONS),
});

export type AgentChatItem = z.infer<typeof agentChatItemSchema>;
export type AgentChatTask = z.infer<typeof agentChatTaskSchema>;
export type AgentChatQueuedMessage = z.infer<typeof agentChatQueuedMessageSchema>;
export type AgentChatItemStatus = z.infer<typeof agentChatItemStatusSchema>;
export type AgentChatTurn = z.infer<typeof agentChatTurnSchema>;
export type AgentChatPlan = z.infer<typeof agentChatPlanSchema>;
export type AgentChatFailureReason = z.infer<typeof agentChatFailureReasonSchema>;
export type AgentChatStatus = z.infer<typeof agentChatStatusSchema>;
export type AgentChatSnapshot = z.infer<typeof agentChatSnapshotSchema>;
export type AgentChatPatchOperation = z.infer<typeof agentChatPatchOperationSchema>;
export type AgentChatPatch = z.infer<typeof agentChatPatchSchema>;
export type AgentChatHistoryPage = z.infer<typeof agentChatHistoryPageSchema>;
export type AgentChatCommand = z.infer<typeof agentChatCommandSchema>;
export type AgentChatModel = z.infer<typeof agentChatModelSchema>;
export type AgentChatImageMediaType = z.infer<typeof agentChatImageMediaTypeSchema>;
/* eslint-enable unicorn/max-nested-calls */

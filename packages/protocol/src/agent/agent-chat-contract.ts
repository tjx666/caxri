/* eslint-disable unicorn/max-nested-calls -- Declarative Zod schemas intentionally compose bounded validators inline. */
import { z } from 'zod';

import { identifierSchema } from '../domain/domain.js';

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
export const MAX_AGENT_CHAT_QUESTIONS = 10;
export const MAX_AGENT_CHAT_MESSAGE_LENGTH = 100_000;
export const MAX_AGENT_CHAT_PATCH_OPERATIONS = 200;
/**
 * Aggregate budget for every item's text. Oldest items are dropped (and `truncated` set) once it is exceeded, so many
 * individually valid items cannot add up to an unbounded snapshot.
 */
export const MAX_AGENT_CHAT_TOTAL_TEXT_LENGTH = 4 * 1024 * 1024;
/**
 * Images one message may attach. Each is bounded by the smaller per-image limit the hosted providers accept (5 MB), so
 * Caxri rejects an oversized image up front instead of letting the provider fail the turn.
 */
export const MAX_AGENT_CHAT_IMAGES = 4;
export const MAX_AGENT_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
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

export const agentChatDecisionSchema = z.enum(['accept', 'acceptForSession', 'decline', 'cancel']);

/**
 * Fields shared by approvals. `itemId` links the approval to the timeline item it gates (the command or file change),
 * so a card can show what it would change. `decisions`, when the provider lists them, are the only choices it accepts.
 */
const approvalBase = {
    id: z.string().min(1).max(200),
    itemId: z.string().min(1).max(200).optional(),
    reason: z.string().max(2_000).optional(),
    decisions: z.array(agentChatDecisionSchema).max(4).optional(),
};

/**
 * A provider request waiting for the user. `id` is Caxri's stable key for the request (the provider item id), not the
 * transport request id, because a provider may re-send a pending request with a new transport id after a resume.
 */
export const agentChatRequestSchema = z.discriminatedUnion('kind', [
    z.strictObject({
        ...approvalBase,
        kind: z.literal('command'),
        command: z.string().max(4_096).optional(),
        cwd: z.string().max(4_096).optional(),
        /**
         * Host a sandboxed command asks to reach, when the approval is for network access rather than the command.
         */
        networkHost: z.string().max(500).optional(),
    }),
    z.strictObject({
        ...approvalBase,
        kind: z.literal('fileChange'),
    }),
    /**
     * Any other tool the provider asks before running (a web fetch, an MCP tool), for providers that gate tools rather
     * than only commands and file changes.
     */
    z.strictObject({
        ...approvalBase,
        kind: z.literal('tool'),
        /**
         * Provider tool name, such as `WebFetch` or an MCP `server__tool` pair.
         */
        name: z.string().max(200),
        /**
         * What the tool would act on: a URL, a query, or a bounded preview of its arguments.
         */
        summary: z.string().max(4_096).optional(),
    }),
    z.strictObject({
        id: z.string().min(1).max(200),
        kind: z.literal('question'),
        questions: z
            .array(
                z.strictObject({
                    id: z.string().min(1).max(200),
                    header: z.string().max(200),
                    question: z.string().max(2_000),
                    options: z
                        .array(
                            z.strictObject({
                                label: z.string().max(200),
                                description: z.string().max(1_000),
                            }),
                        )
                        .max(20),
                    allowsOther: z.boolean(),
                }),
            )
            .max(MAX_AGENT_CHAT_QUESTIONS),
    }),
]);

/**
 * Why a Chat cannot currently run. Closed so the Renderer maps each to actionable copy; provider text never selects UI.
 */
export const agentChatFailureReasonSchema = z.enum([
    'executable_not_found',
    'spawn_failed',
    'handshake_failed',
    'process_exited',
    'resume_failed',
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
     * True when older history exists than `items` holds.
     */
    truncated: z.boolean(),
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
     * Models `agentChat.configure` can switch to. Absent until the provider has listed them.
     */
    models: z.array(agentChatModelSchema).max(MAX_AGENT_CHAT_MODELS).optional(),
    /**
     * Slash commands the provider currently offers. Absent until the provider has started.
     */
    commands: z.array(agentChatCommandSchema).max(MAX_AGENT_CHAT_COMMANDS).optional(),
    usage: z
        .strictObject({
            totalTokens: z.number().int().nonnegative(),
            contextWindow: z.number().int().nonnegative().optional(),
        })
        .optional(),
    /**
     * Provider-wide work in progress that is not a turn, such as compacting the context.
     */
    operation: z.enum(['compacting']).optional(),
    tasks: z.array(agentChatTaskSchema).max(MAX_AGENT_CHAT_TASKS).optional(),
    queue: z.array(agentChatQueuedMessageSchema).max(MAX_AGENT_CHAT_QUEUE).optional(),
    /**
     * True after the user stopped a turn with messages still queued; nothing is sent until they resume the queue.
     */
    queuePaused: z.boolean().optional(),
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
                models: agentChatSnapshotSchema.shape.models.unwrap(),
                commands: agentChatSnapshotSchema.shape.commands.unwrap(),
                usage: agentChatSnapshotSchema.shape.usage.unwrap().nullable(),
                truncated: agentChatSnapshotSchema.shape.truncated,
                operation: agentChatSnapshotSchema.shape.operation.unwrap().nullable(),
                tasks: agentChatSnapshotSchema.shape.tasks.unwrap(),
                queue: agentChatSnapshotSchema.shape.queue.unwrap(),
                queuePaused: agentChatSnapshotSchema.shape.queuePaused.unwrap(),
            })
            .partial(),
    }),
    z.strictObject({ op: z.literal('reset') }),
]);

export const agentChatPatchSchema = z.strictObject({
    terminalId: identifierSchema,
    baseRevision: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    operations: z.array(agentChatPatchOperationSchema).min(1).max(MAX_AGENT_CHAT_PATCH_OPERATIONS),
});

/**
 * The conversation of one task: a subagent's own messages and tool rows, or a background shell's output tail. Kept
 * apart from the parent projection with its own revisions and budget.
 */
export const agentChatTaskSnapshotSchema = z.strictObject({
    terminalId: identifierSchema,
    taskId: agentChatTaskSchema.shape.id,
    revision: z.number().int().nonnegative(),
    truncated: z.boolean(),
    items: z.array(agentChatItemSchema).max(MAX_AGENT_CHAT_TASK_ITEMS),
    /**
     * Tail of a background shell's output.
     */
    output: boundedOutput.optional(),
    /**
     * Set when the provider stopped streaming this shell's output (Codex caps the deltas of one command), so the tab
     * says the output is no longer live instead of looking idle.
     */
    isOutputCapped: z.boolean().optional(),
});

export const agentChatTaskPatchOperationSchema = z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('upsertItem'), item: agentChatItemSchema }),
    z.strictObject({
        op: z.literal('appendText'),
        itemId: z.string().min(1).max(200),
        delta: z.string().max(MAX_AGENT_CHAT_TEXT_LENGTH),
    }),
    z.strictObject({
        op: z.literal('appendOutput'),
        delta: z.string().max(MAX_AGENT_CHAT_TEXT_LENGTH),
    }),
    z.strictObject({
        op: z.literal('state'),
        state: z
            .strictObject({
                output: boundedOutput,
                isOutputCapped: z.boolean(),
                truncated: z.boolean(),
            })
            .partial(),
    }),
    z.strictObject({ op: z.literal('reset') }),
]);

export const agentChatTaskPatchSchema = z.strictObject({
    terminalId: identifierSchema,
    taskId: agentChatTaskSchema.shape.id,
    baseRevision: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    operations: z
        .array(agentChatTaskPatchOperationSchema)
        .min(1)
        .max(MAX_AGENT_CHAT_PATCH_OPERATIONS),
});

export type AgentChatItem = z.infer<typeof agentChatItemSchema>;
export type AgentChatTask = z.infer<typeof agentChatTaskSchema>;
export type AgentChatQueuedMessage = z.infer<typeof agentChatQueuedMessageSchema>;
export type AgentChatTaskSnapshot = z.infer<typeof agentChatTaskSnapshotSchema>;
export type AgentChatTaskPatchOperation = z.infer<typeof agentChatTaskPatchOperationSchema>;
export type AgentChatTaskPatch = z.infer<typeof agentChatTaskPatchSchema>;
export type AgentChatItemStatus = z.infer<typeof agentChatItemStatusSchema>;
export type AgentChatTurn = z.infer<typeof agentChatTurnSchema>;
export type AgentChatPlan = z.infer<typeof agentChatPlanSchema>;
export type AgentChatRequest = z.infer<typeof agentChatRequestSchema>;
export type AgentChatFailureReason = z.infer<typeof agentChatFailureReasonSchema>;
export type AgentChatStatus = z.infer<typeof agentChatStatusSchema>;
export type AgentChatSnapshot = z.infer<typeof agentChatSnapshotSchema>;
export type AgentChatPatchOperation = z.infer<typeof agentChatPatchOperationSchema>;
export type AgentChatPatch = z.infer<typeof agentChatPatchSchema>;
export type AgentChatDecision = z.infer<typeof agentChatDecisionSchema>;
export type AgentChatCommand = z.infer<typeof agentChatCommandSchema>;
export type AgentChatModel = z.infer<typeof agentChatModelSchema>;
export type AgentChatImageMediaType = z.infer<typeof agentChatImageMediaTypeSchema>;
/* eslint-enable unicorn/max-nested-calls */

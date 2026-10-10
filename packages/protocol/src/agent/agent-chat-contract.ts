/* eslint-disable unicorn/max-nested-calls -- Declarative Zod schemas intentionally compose bounded validators inline. */
import { z } from 'zod';

import { identifierSchema } from '../domain/domain.js';
import { commandPolicy } from '../transport/method-spec.js';

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
const thumbnailSchema = z
    .string()
    .max(MAX_AGENT_CHAT_THUMBNAIL_LENGTH)
    .regex(/^data:image\/(?:png|jpeg|gif|webp);base64,[\d+/A-Za-z]+={0,2}$/u);

/**
 * An image attached to a user message. `thumbnail` is absent when the provider's history carries the image but no
 * preview Caxri made, such as a resumed conversation; the Chat then shows a placeholder.
 */
export const agentChatImageReferenceSchema = z.strictObject({
    thumbnail: thumbnailSchema.optional(),
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
     * Slash commands the provider currently offers. Absent until the provider has started.
     */
    commands: z.array(agentChatCommandSchema).max(MAX_AGENT_CHAT_COMMANDS).optional(),
    usage: z
        .strictObject({
            totalTokens: z.number().int().nonnegative(),
            contextWindow: z.number().int().nonnegative().optional(),
        })
        .optional(),
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
                commands: agentChatSnapshotSchema.shape.commands.unwrap(),
                usage: agentChatSnapshotSchema.shape.usage.unwrap().nullable(),
                truncated: agentChatSnapshotSchema.shape.truncated,
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

export type AgentChatItem = z.infer<typeof agentChatItemSchema>;
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
export type AgentChatImageMediaType = z.infer<typeof agentChatImageMediaTypeSchema>;
export type AgentChatImageInput = z.infer<typeof agentChatImageInputSchema>;
export type AgentChatMessageInput = Omit<
    z.infer<typeof agentChatSendParametersSchema>,
    'terminalId'
>;

/**
 * Upper bound of an image's base64 length, from its byte limit.
 */
const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MAX_AGENT_CHAT_IMAGE_BYTES / 3) * 4;

/**
 * An image a message sends. `data` is the full image, delivered to the provider and never stored in the projection or
 * logs; `thumbnail` is the preview the user message shows.
 */
export const agentChatImageInputSchema = z.strictObject({
    mediaType: agentChatImageMediaTypeSchema,
    data: z
        .string()
        .min(1)
        .max(MAX_IMAGE_BASE64_LENGTH)
        .regex(/^[\d+/A-Za-z]+={0,2}$/u),
    thumbnail: thumbnailSchema,
});

const terminalTarget = { terminalId: identifierSchema };

const agentChatSendParametersSchema = z
    .strictObject({
        ...terminalTarget,
        text: z.string().trim().max(MAX_AGENT_CHAT_MESSAGE_LENGTH),
        images: z.array(agentChatImageInputSchema).max(MAX_AGENT_CHAT_IMAGES).optional(),
    })
    .refine((message) => message.text.length > 0 || (message.images?.length ?? 0) > 0, {
        message: 'A message needs text or an image',
    });

/**
 * Agent Chat methods: the structured surface of a Chat Terminal. See `docs/agent-chat.md`.
 */
export const agentChatMethods = {
    /**
     * Returns the current conversation projection, starting or resuming the provider process when none is running.
     */
    'agentChat.read': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject(terminalTarget),
        result: agentChatSnapshotSchema,
    },
    /**
     * Starts a turn, or steers the running one, with the user's message and any attached images.
     */
    'agentChat.send': {
        ...commandPolicy('server', 'control'),
        params: agentChatSendParametersSchema,
        result: z.null(),
    },
    /**
     * Runs one of the snapshot's `commands`. A command the provider does not offer fails with `VALIDATION`; one that
     * cannot run during a turn fails with `CONFLICT`.
     */
    'agentChat.runCommand': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({
            ...terminalTarget,
            name: agentChatCommandSchema.shape.name,
            arguments: z.string().trim().max(MAX_AGENT_CHAT_MESSAGE_LENGTH).optional(),
        }),
        result: z.null(),
    },
    'agentChat.interrupt': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject(terminalTarget),
        result: z.null(),
    },
    /**
     * Answers one pending approval or question. A request that is no longer pending fails with `CONFLICT`.
     */
    'agentChat.respond': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({
            ...terminalTarget,
            requestId: z.string().min(1).max(200),
            response: z.discriminatedUnion('kind', [
                z.strictObject({ kind: z.literal('decision'), decision: agentChatDecisionSchema }),
                z.strictObject({
                    kind: z.literal('answers'),
                    answers: z.record(z.string().max(200), z.array(z.string().max(2_000)).max(10)),
                }),
            ]),
        }),
        result: z.null(),
    },
};
/* eslint-enable unicorn/max-nested-calls */

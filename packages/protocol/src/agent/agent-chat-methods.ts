/* eslint-disable unicorn/max-nested-calls -- Declarative Zod schemas intentionally compose bounded validators inline. */
import { z } from 'zod';

import { agentProviderSchema, identifierSchema, projectRecordSchema } from '../domain/domain.js';
import {
    isLongPasteWithinLimit,
    MAX_LONG_PASTE_BYTES,
    savedLongPasteSchema,
} from '../domain/terminal-long-paste.js';
import { commandPolicy } from '../transport/method-spec.js';
import {
    agentChatCommandSchema,
    agentChatEffortSchema,
    agentChatHistoryPageSchema,
    agentChatImageMediaTypeSchema,
    agentChatModelSchema,
    agentChatQueuedMessageSchema,
    agentChatSnapshotSchema,
    agentChatTaskSchema,
    agentChatThumbnailSchema,
    MAX_AGENT_CHAT_IMAGE_BYTES,
    MAX_AGENT_CHAT_IMAGES,
    MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES,
    MAX_AGENT_CHAT_MESSAGE_LENGTH,
} from './agent-chat-contract.js';
import { agentChatDefaultSchema, agentChatPermissionModeSchema } from './agent-chat-permissions.js';
import { agentChatDecisionSchema } from './agent-chat-requests.js';
import { agentChatTaskSnapshotSchema } from './agent-chat-task-contract.js';

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
    thumbnail: agentChatThumbnailSchema,
});

/**
 * Upper bound of one message's combined image base64 length, from {@link MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES}. Padding
 * makes each image's encoding round up to a multiple of four, so every image may add up to three characters more.
 */
const MAX_IMAGES_TOTAL_BASE64_LENGTH =
    Math.ceil(MAX_AGENT_CHAT_IMAGES_TOTAL_BYTES / 3) * 4 + MAX_AGENT_CHAT_IMAGES * 3;

const terminalTarget = { terminalId: identifierSchema };

const messageContent = {
    text: z.string().trim().max(MAX_AGENT_CHAT_MESSAGE_LENGTH),
    images: z
        .array(agentChatImageInputSchema)
        .max(MAX_AGENT_CHAT_IMAGES)
        .refine(
            (images) =>
                images.reduce((total, image) => total + image.data.length, 0) <=
                MAX_IMAGES_TOTAL_BASE64_LENGTH,
            { message: 'Images in one message exceed the combined size limit' },
        )
        .optional(),
};

const hasMessageContent = (message: { text: string; images?: unknown[] }): boolean =>
    message.text.length > 0 || (message.images?.length ?? 0) > 0;

const agentChatSendParametersSchema = z
    .strictObject({
        ...terminalTarget,
        ...messageContent,
        /**
         * What a message sent while a turn runs does: `queue` (the default) holds it until the turn ends, `steer` adds
         * it to the running turn. A message sent while the Chat is idle starts a turn either way.
         */
        delivery: z.enum(['queue', 'steer']).optional(),
    })
    .refine(hasMessageContent, { message: 'A message needs text or an image' });

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
     * Returns the page of history right before `beforeItemId`, the oldest item the Client holds (the projection's first
     * item, or the first item of the last page read). Read from the history Server Core keeps once items leave the
     * projection, then from the provider's own record. An unknown `beforeItemId` returns an empty page.
     */
    'agentChat.readHistory': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({ ...terminalTarget, beforeItemId: z.string().min(1).max(200) }),
        result: agentChatHistoryPageSchema,
    },
    /**
     * Starts a turn with the user's message and any attached images. While a turn runs, the message is queued or steers
     * the running turn, as `delivery` asks.
     */
    'agentChat.send': {
        ...commandPolicy('server', 'control'),
        params: agentChatSendParametersSchema,
        result: z.null(),
    },
    /**
     * Runs one of the snapshot's `commands`. A command the provider does not offer fails with `VALIDATION`. A command
     * issued while a turn runs is queued until the turn ends.
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
    /**
     * Switches the model, reasoning effort, ultracode, permission level, or plan mode for the next turn and the ones
     * after it; a running turn keeps its own. A model the snapshot's `models` does not list, an effort that model does
     * not accept, ultracode while the snapshot does not offer it, or a level or plan mode the provider does not offer
     * (`agentChatPermissionCapabilities`), fails with `VALIDATION`. A provider that fixes its permission at launch
     * (Grok Build) restarts on the same conversation to apply one, and fails with `CONFLICT` while a turn runs.
     */
    'agentChat.configure': {
        ...commandPolicy('server', 'control'),
        params: z
            .strictObject({
                ...terminalTarget,
                model: agentChatModelSchema.shape.id.optional(),
                effort: agentChatEffortSchema.optional(),
                ultracode: z.boolean().optional(),
                permissionMode: agentChatPermissionModeSchema.optional(),
                planMode: z.boolean().optional(),
            })
            .refine(
                (change) =>
                    change.model !== undefined ||
                    change.effort !== undefined ||
                    change.ultracode !== undefined ||
                    change.permissionMode !== undefined ||
                    change.planMode !== undefined,
                {
                    message:
                        'Choose a model, an effort, ultracode, a permission level, or plan mode',
                },
            ),
        result: z.null(),
    },
    /**
     * "Edit from here": rewinds the conversation to just before user message `itemId` through the provider's own
     * record, removing that turn and every later one, then sends the edited message as the new next turn.
     * `restoreFiles` also restores the files those turns changed from the provider's file checkpoints; a provider
     * without them (`capabilities.chatRewindFiles`) fails with `VALIDATION`. A running turn, or a message that did not
     * start its turn, fails with `CONFLICT` before anything changes.
     */
    'agentChat.rewind': {
        ...commandPolicy('server', 'control'),
        params: z
            .strictObject({
                ...terminalTarget,
                itemId: z.string().min(1).max(200),
                restoreFiles: z.boolean(),
                ...messageContent,
            })
            .refine(hasMessageContent, { message: 'A message needs text or an image' }),
        result: z.null(),
    },
    /**
     * "Fork from here": copies the conversation up to just before user message `itemId` into a new Agent Session
     * through the provider's own fork, then opens it as a Chat in a new Session of the same Project and cwd, without
     * selecting it. The source Chat is left as it was. A running turn, or a message that did not start its turn, fails
     * with `CONFLICT` before anything is created. Forking the first message opens an empty Chat.
     */
    'agentChat.fork': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({ ...terminalTarget, itemId: z.string().min(1).max(200) }),
        result: z.strictObject({ sessionId: identifierSchema, terminalId: identifierSchema }),
    },
    /**
     * "Restore code to here": restores the files the turns from user message `itemId` onward changed, from the
     * provider's file checkpoints, and keeps the conversation. A provider without them (`capabilities.chatRewindFiles`)
     * fails with `VALIDATION`; a running turn, or a message that did not start its turn, fails with `CONFLICT` before
     * anything changes.
     */
    'agentChat.restoreFiles': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({ ...terminalTarget, itemId: z.string().min(1).max(200) }),
        result: z.null(),
    },
    /**
     * Stops the running turn. Messages still queued stay queued and the queue pauses until `agentChat.resumeQueue`.
     * Background tasks keep running.
     */
    'agentChat.interrupt': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject(terminalTarget),
        result: z.null(),
    },
    /**
     * Returns one task's own conversation or output. Fails with `NOT_FOUND` when neither the live Chat nor the
     * provider's history knows the task. `taskId` may also name the timeline item that started the task.
     */
    'agentChat.readTask': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({ ...terminalTarget, taskId: agentChatTaskSchema.shape.id }),
        result: agentChatTaskSnapshotSchema,
    },
    /**
     * Returns the original of an image a user message carried, read from the provider's own record, so a Client can
     * preview an image the projection holds without a thumbnail (a resumed conversation). `index` is the image's
     * position in the message's `images`. Resolves `null` when the record no longer has that image or the provider
     * keeps none.
     */
    'agentChat.readImage': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({
            ...terminalTarget,
            itemId: z.string().min(1).max(200),
            index: z
                .number()
                .int()
                .min(0)
                .max(MAX_AGENT_CHAT_IMAGES - 1),
        }),
        result: agentChatImageInputSchema.omit({ thumbnail: true }).nullable(),
    },
    /**
     * Stops one running task without ending the turn or the Chat.
     */
    'agentChat.stopTask': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({ ...terminalTarget, taskId: agentChatTaskSchema.shape.id }),
        result: z.null(),
    },
    /**
     * Removes a queued message. A message that already left the queue fails with `CONFLICT`.
     */
    'agentChat.removeQueued': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({ ...terminalTarget, id: agentChatQueuedMessageSchema.shape.id }),
        result: z.null(),
    },
    /**
     * Sends a queued message now: it steers the running turn, or starts a turn when the Chat is idle.
     */
    'agentChat.sendQueuedNow': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({ ...terminalTarget, id: agentChatQueuedMessageSchema.shape.id }),
        result: z.null(),
    },
    /**
     * Resumes a queue paused by an interrupt, sending its next message once the Chat is idle.
     */
    'agentChat.resumeQueue': {
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
    /**
     * Saves text too long for the message input to a local file and returns where it is, so the message cites the file
     * (`formatLongPasteReference`) instead of carrying the text. It shares the Terminal long paste directory and
     * retention; the text never enters logs or SQLite.
     */
    'agentChat.saveLongPaste': {
        ...commandPolicy('server', 'control'),
        idempotency: 'none' as const,
        params: z.strictObject({
            ...terminalTarget,
            content: z.string().min(1).max(MAX_LONG_PASTE_BYTES).refine(isLongPasteWithinLimit, {
                message: 'Pasted text exceeds the local file safety limit',
            }),
        }),
        result: savedLongPasteSchema,
    },
    /**
     * Native confirmation before "Edit from here" restores files: putting back the files later turns changed overwrites
     * whatever is on disk now, including the user's own edits since, so it takes the native sheet DESIGN.md reserves
     * for destructive actions. Main only asks; the Renderer sends `agentChat.rewind` once the user agrees.
     */
    'agentChat.confirmRevertFiles': {
        ...commandPolicy('desktop', 'control'),
        params: z.object({
            providerName: z.string().min(1).max(100),
            removedTurns: z.number().int().positive(),
        }),
        result: z.object({ confirmed: z.boolean() }),
    },
    /**
     * Saves the permission level and plan mode new `provider` Chats in this Project start with; `null` clears it so new
     * Chats follow the provider's launch settings again. Existing Chats keep their own choice. It lives with the Chat
     * methods because only the Chat composer sets it.
     */
    'project.setChatDefault': {
        ...commandPolicy('server', 'write'),
        params: z.strictObject({
            projectId: identifierSchema,
            provider: agentProviderSchema,
            chatDefault: agentChatDefaultSchema.nullable(),
        }),
        result: projectRecordSchema,
    },
};
/* eslint-enable unicorn/max-nested-calls */

/**
 * The answer `agentChat.respond` carries: a decision on an approval, or the answers to a question.
 */
export type AgentChatResponse = z.infer<
    (typeof agentChatMethods)['agentChat.respond']['params']
>['response'];

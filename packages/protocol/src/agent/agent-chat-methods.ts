/* eslint-disable unicorn/max-nested-calls -- Declarative Zod schemas intentionally compose bounded validators inline. */
import { z } from 'zod';

import { identifierSchema } from '../domain/domain.js';
import { commandPolicy } from '../transport/method-spec.js';
import {
    agentChatCommandSchema,
    agentChatEffortSchema,
    agentChatImageMediaTypeSchema,
    agentChatModelSchema,
    agentChatQueuedMessageSchema,
    agentChatSnapshotSchema,
    agentChatTaskSchema,
    agentChatTaskSnapshotSchema,
    agentChatThumbnailSchema,
    MAX_AGENT_CHAT_IMAGE_BYTES,
    MAX_AGENT_CHAT_IMAGES,
    MAX_AGENT_CHAT_MESSAGE_LENGTH,
} from './agent-chat-contract.js';
import { agentChatDecisionSchema } from './agent-chat-requests.js';

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

const terminalTarget = { terminalId: identifierSchema };

const agentChatSendParametersSchema = z
    .strictObject({
        ...terminalTarget,
        text: z.string().trim().max(MAX_AGENT_CHAT_MESSAGE_LENGTH),
        images: z.array(agentChatImageInputSchema).max(MAX_AGENT_CHAT_IMAGES).optional(),
        /**
         * What a message sent while a turn runs does: `queue` (the default) holds it until the turn ends, `steer` adds
         * it to the running turn. A message sent while the Chat is idle starts a turn either way.
         */
        delivery: z.enum(['queue', 'steer']).optional(),
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
     * Switches the model or reasoning effort for the next turn and the ones after it; a running turn keeps its own. A
     * model the snapshot's `models` does not list, or an effort that model does not accept, fails with `VALIDATION`.
     */
    'agentChat.configure': {
        ...commandPolicy('server', 'control'),
        params: z
            .strictObject({
                ...terminalTarget,
                model: agentChatModelSchema.shape.id.optional(),
                effort: agentChatEffortSchema.optional(),
            })
            .refine((change) => change.model !== undefined || change.effort !== undefined, {
                message: 'Choose a model or an effort',
            }),
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
};
/* eslint-enable unicorn/max-nested-calls */

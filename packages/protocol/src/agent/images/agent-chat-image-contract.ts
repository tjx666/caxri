import { z } from 'zod';

import { identifierSchema } from '../../domain/identifiers.js';
import { commandPolicy } from '../../transport/method-spec.js';
import { agentChatImageMediaTypeSchema, agentChatThumbnailSchema } from '../agent-chat-images.js';
import { MAX_AGENT_CHAT_IMAGE_BYTES, MAX_AGENT_CHAT_IMAGES } from '../agent-chat-limits.js';

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

export type AgentChatImageInput = z.infer<typeof agentChatImageInputSchema>;

/**
 * What `agentChat.readImage` answers while the provider's record does not hold the message yet. Claude Code records a
 * message sent mid-turn only once the running turn takes it in, which can be minutes after the Chat already shows it,
 * so a Client asks again later instead of treating the original as missing.
 */
export const agentChatImagePendingSchema = z.strictObject({ pending: z.literal(true) });

export type AgentChatImagePending = z.infer<typeof agentChatImagePendingSchema>;

/**
 * Whether a read image answer, or what a Client cached from one, is {@link agentChatImagePendingSchema}.
 */
export const isAgentChatImagePending = (value: unknown): value is AgentChatImagePending =>
    typeof value === 'object' && value !== null && 'pending' in value;

const AGENT_CHAT_IMAGE_RECORD_RETRY_FIRST_MS = 2000;
const AGENT_CHAT_IMAGE_RECORD_RETRY_MAX_MS = 15_000;
/**
 * Answers after which a Client stops asking, about four and a half minutes in: long enough for a turn to take in a
 * message queued behind a long tool call, without re-reading a large record forever for a message it never holds.
 */
const AGENT_CHAT_IMAGE_RECORD_MAX_ATTEMPTS = 20;

/**
 * How long to wait before asking again for an image whose message the provider's record does not hold yet, after
 * `attempts` answers so far: 2 s, then doubling up to 15 s, and `false` once the Client should give up and show the
 * image as unavailable. A message sent while the Agent works is recorded only once the running turn takes it in, which
 * can be a long tool call away, and a large record is re-read on every ask.
 */
export const agentChatImageRetryDelay = (attempts: number): number | false =>
    attempts >= AGENT_CHAT_IMAGE_RECORD_MAX_ATTEMPTS
        ? false
        : Math.min(
              AGENT_CHAT_IMAGE_RECORD_RETRY_MAX_MS,
              AGENT_CHAT_IMAGE_RECORD_RETRY_FIRST_MS * 2 ** Math.max(0, attempts - 1),
          );

/**
 * A read image answer as a Client should keep it after `answers` earlier ones: a `pending` answer becomes `null` once
 * {@link agentChatImageRetryDelay} gives up, so the image shows as unavailable and the Client stops asking.
 */
export const settleAgentChatImageAnswer = <T>(
    answer: T | AgentChatImagePending | null,
    answers: number,
): T | AgentChatImagePending | null =>
    isAgentChatImagePending(answer) && agentChatImageRetryDelay(answers + 1) === false
        ? null
        : answer;

/**
 * The `agentChat.*` method that reads back an image a user message carried.
 */
export const agentChatImageMethods = {
    /**
     * Returns the original of an image a user message carried, read from the provider's own record, so a Client can
     * preview an image the projection holds without a thumbnail (a resumed conversation). `index` is the image's
     * position in the message's `images`. Resolves `{ pending: true }` while the record does not hold the message yet,
     * and `null` when the record has no readable image there or the provider keeps none.
     */
    'agentChat.readImage': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({
            terminalId: identifierSchema,
            itemId: z.string().min(1).max(200),
            index: z
                .number()
                .int()
                .min(0)
                .max(MAX_AGENT_CHAT_IMAGES - 1),
        }),
        result: z
            .union([
                agentChatImageInputSchema.omit({ thumbnail: true }),
                agentChatImagePendingSchema,
            ])
            .nullable(),
    },
};

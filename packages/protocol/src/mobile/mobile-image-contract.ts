import { z } from 'zod';

import { MAX_AGENT_CHAT_IMAGES } from '../agent/agent-chat-contract.js';
import { identifierSchema } from '../domain/identifiers.js';
import { principalSchema } from '../transport/principal.js';

/**
 * A phone-made image upload ID. The Server keeps the uploaded JPEG under this ID until a Terminal Agent submission or a
 * Chat message references it; see `docs/mobile/conversation.md`.
 */
export const mobileAttachmentIdSchema = z.string().regex(/^image_[0-9a-f]{32}$/u);

export const mobileImageUploadParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    attachmentId: mobileAttachmentIdSchema,
    chunkIndex: z.number().int().min(0).max(191),
    chunkCount: z.number().int().min(1).max(192),
    chunk: z
        .string()
        .min(4)
        .max(24_576)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
});

/**
 * `mobile.image.readInternal` returns the uploaded JPEGs a Chat message names, as base64, for the gateway to pass to
 * `agentChat.send`. Only the uploading device generation may read them, and only under the Session they were uploaded
 * to. Each Chat attachment is an image and its thumbnail, so at most twice `MAX_AGENT_CHAT_IMAGES` uploads.
 */
export const mobileImageReadInternalParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    attachmentIds: z
        .array(mobileAttachmentIdSchema)
        .min(1)
        .max(MAX_AGENT_CHAT_IMAGES * 2),
    principal: principalSchema,
});

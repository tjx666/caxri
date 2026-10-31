import { z } from 'zod';

import { agentChatMethods } from '../agent/agent-chat-methods.js';
import { identifierSchema, pathSchema } from '../domain/identifiers.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { MOBILE_AGENT_CHAT_IMAGE_CHUNK_LENGTH } from './mobile-agent-chat-contract.js';

/**
 * A video one user message of an Agent Chat cites (`agentChatMessageVideoPaths`). Server Core serves only a path that
 * message cites, so the phone names the message as well as the path.
 */
const mobileVideoTarget = {
    terminalId: identifierSchema,
    itemId: agentChatMethods['agentChat.readImage'].params.shape.itemId,
    path: pathSchema,
};

/**
 * One chunk of the video's poster frame, paged like `mobile.agentChat.readImage`, so it reaches the phone over the
 * Relay too.
 */
const mobileVideoPosterChunkSchema = z.strictObject({
    mediaType: z.enum(['image/jpeg', 'image/png']),
    data: z
        .string()
        .max(MOBILE_AGENT_CHAT_IMAGE_CHUNK_LENGTH)
        .regex(/^[\d+/A-Za-z]*={0,2}$/u),
    chunkIndex: z.number().int().nonnegative(),
    chunkCount: z.number().int().positive(),
});

/**
 * Videos a Chat message cites, shown on the phone as cards; see `docs/mobile/video.md`. Every paired role may read
 * them: they are part of a message the role can already read, and neither method changes anything.
 */
export const mobileVideoMethods = {
    /**
     * Whether the video still plays and its poster frame. `null` when the file is gone, is not a regular file, or
     * resolves to a path that is not a video; the card then reads as unavailable. `poster` is `null` when the computer
     * could not draw a frame (an unsupported codec, or a Server without QuickLook), and the video may still play.
     */
    'mobile.video.read': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({
            ...mobileVideoTarget,
            chunkIndex: z.number().int().nonnegative().max(1_000).default(0),
        }),
        result: z.strictObject({ poster: mobileVideoPosterChunkSchema.nullable() }).nullable(),
    },
    /**
     * A plain-HTTP URL on the gateway address the phone is connected through that streams the video with range
     * requests. Its token is the only authority, so it is issued exclusively over the sealed channel. `UNAVAILABLE`
     * over the Relay, which cannot reach the gateway's plain-HTTP side, and `NOT_FOUND` when the video is gone.
     */
    'mobile.video.open': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject(mobileVideoTarget),
        result: z.strictObject({ url: z.url({ protocol: /^http$/u }).max(2_048) }),
    },
} as const satisfies Record<string, MethodSpec>;

import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { principalSchema } from '../transport/principal.js';
import {
    mobileMessageChunkSchema,
    mobileMessageOffsetSchema,
} from './mobile-message-read-contract.js';

/**
 * Characters of a Terminal Agent message the timeline keeps; a message that reaches this length may be cut, and the
 * phone reads its whole text through `mobile.timeline.readMessage` before copying it.
 */
export const MOBILE_TIMELINE_MESSAGE_PREVIEW_LENGTH = 4_096;

const readMessageParameters = {
    sessionId: identifierSchema,
    itemId: z.string().min(1).max(128),
    offset: mobileMessageOffsetSchema,
};

/**
 * The phone's request for the whole text of one Terminal Agent message, for Copy and Select Text: the timeline keeps
 * only the first 4,096 characters of a long message. `itemId` comes from `mobile.timeline.read`; the message is re-read
 * from the Agent's transcript, so an id from a transcript that has since been rewritten fails with `NOT_FOUND`, and a
 * message over `MOBILE_MESSAGE_READ_MAX_BYTES` fails with `VALIDATION`.
 */
export const mobileTimelineMessageMethods = {
    'mobile.timeline.readMessage': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject(readMessageParameters),
        result: mobileMessageChunkSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export const mobileTimelineMessageInternalMethods = {
    'mobile.timeline.readMessageInternal': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({ ...readMessageParameters, principal: principalSchema }),
        result: mobileMessageChunkSchema,
    },
} as const satisfies Record<string, MethodSpec>;

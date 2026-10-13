import { z } from 'zod';

import { identifierSchema, pathSchema } from './identifiers.js';

/**
 * Upper bound on the condensed Markdown a reference file holds. A long Session keeps its most recent messages; the file
 * says how many earlier ones it left out so the Agent knows the record is partial.
 */
export const MAX_SESSION_CONVERSATION_REFERENCE_BYTES = 256 * 1024;

export const sessionConversationReferenceParametersSchema = z.object({
    sessionId: identifierSchema,
});

/**
 * Where the condensed conversation was written, and how much of it the file holds. The Renderer inserts `filePath` as
 * an `@` reference; it never receives the conversation text itself.
 */
export const sessionConversationReferenceResultSchema = z.object({
    filePath: pathSchema,
    title: z.string(),
    messageCount: z.number().int().nonnegative(),
    omittedMessageCount: z.number().int().nonnegative(),
});

export type SessionConversationReference = z.infer<typeof sessionConversationReferenceResultSchema>;

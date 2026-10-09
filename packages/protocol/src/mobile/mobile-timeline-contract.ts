import { z } from 'zod';

import { identifierSchema } from '../domain/domain.js';

const timelineItemBase = {
    id: z.string().min(1).max(128),
    timestamp: z.number().int().nonnegative().optional(),
};

/**
 * Harness-injected content the provider CLI writes into the transcript on the user's turn, never text the reader typed.
 * `taskNotification` is a background Agent completion; `slashCommand` is a `/command` echo, including its stdout when
 * the harness inlines one; `bashCommand` is a `!`-prefixed shell echo with its stdout/stderr; `caveat` is a one-line
 * harness disclaimer attached to a slash command. `systemReminder` content never reaches the timeline as an item; a
 * turn made of only a system reminder is dropped instead of rendered.
 */
export const agentSystemEventStatusSchema = z.enum([
    'completed',
    'failed',
    'killed',
    'running',
    'unknown',
]);

export const agentSystemEventKindSchema = z.enum([
    'taskNotification',
    'slashCommand',
    'bashCommand',
    'caveat',
]);

export const agentTimelineItemSchema = z.discriminatedUnion('type', [
    z.strictObject({
        ...timelineItemBase,
        type: z.literal('userMessage'),
        text: z.string().min(1).max(32_768),
    }),
    z.strictObject({
        ...timelineItemBase,
        type: z.literal('agentMessage'),
        text: z.string().min(1).max(32_768),
    }),
    z.strictObject({
        ...timelineItemBase,
        type: z.literal('toolCall'),
        name: z.string().min(1).max(100),
        summary: z.string().min(1).max(240),
        status: z.enum(['running', 'succeeded', 'failed']),
        durationMs: z.number().int().nonnegative().optional(),
        detail: z.string().max(2_048).optional(),
    }),
    z.strictObject({
        ...timelineItemBase,
        type: z.literal('turnBoundary'),
        durationMs: z.number().int().nonnegative().optional(),
    }),
    z.strictObject({
        ...timelineItemBase,
        type: z.literal('systemEvent'),
        kind: agentSystemEventKindSchema,
        summary: z.string().min(1).max(240),
        /**
         * Outcome a `taskNotification` reports; absent for event kinds that carry no outcome.
         */
        status: agentSystemEventStatusSchema.optional(),
        detail: z.string().max(2_048).optional(),
    }),
]);

export const mobileTimelineReadParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    before: z.string().min(1).max(128).optional(),
    limit: z.number().int().min(1).max(80).default(40),
});

export const mobileTimelineReadResultSchema = z.strictObject({
    status: z.enum(['available', 'unsupported', 'missing']),
    items: z.array(agentTimelineItemSchema).max(80),
    olderCursor: z.string().min(1).max(128).optional(),
    truncated: z.boolean(),
    cursorExpired: z.boolean(),
});

export type AgentTimelineItem = z.infer<typeof agentTimelineItemSchema>;
export type AgentSystemEventKind = z.infer<typeof agentSystemEventKindSchema>;
export type AgentSystemEventStatus = z.infer<typeof agentSystemEventStatusSchema>;
export type MobileTimelineReadResult = z.infer<typeof mobileTimelineReadResultSchema>;

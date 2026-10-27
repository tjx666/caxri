/* eslint-disable unicorn/max-nested-calls -- Declarative Zod schemas intentionally compose bounded validators inline. */
import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * Upper bound of one excerpt; the hover card and Activity rows clamp it to a couple of lines anyway.
 */
export const AGENT_EXCERPT_MAX_LENGTH = 240;

/**
 * Sessions one `agent.excerpts` call may ask about: the visible Activity rows and the open hover card.
 */
export const AGENT_EXCERPT_MAX_SESSIONS = 50;

export const agentExcerptSchema = z.strictObject({
    /**
     * `request` is what the Agent is waiting on (a question it asked, or the action it wants approved); `reply` is the
     * closing message of its latest turn.
     */
    kind: z.enum(['request', 'reply']),
    text: z.string().min(1).max(AGENT_EXCERPT_MAX_LENGTH),
});

export const agentExcerptMethods = {
    /**
     * Short excerpts of what the Primary Agent of each Session last said or is waiting on, for the Session hover card
     * and Activity rows. Read-only and cheap by design: it takes the pending request from a Chat that is already live
     * and otherwise the last reply from the on-disk transcript, so it never starts a provider. A Session whose
     * `attentionGeneration` has moved on since the Renderer asked, or that has nothing to show (no Agent, no transcript
     * parser, a Terminal Agent without a pending reply), is simply absent from the answer. The text is user content:
     * the Server never persists, caches, or logs it.
     */
    'agent.excerpts': {
        ...commandPolicy('server', 'read'),
        params: z.strictObject({
            sessions: z
                .array(
                    z.strictObject({
                        sessionId: identifierSchema,
                        attentionGeneration: z.number().int().nonnegative(),
                    }),
                )
                .max(AGENT_EXCERPT_MAX_SESSIONS),
        }),
        result: z.strictObject({
            excerpts: z.record(identifierSchema, agentExcerptSchema),
        }),
    },
} as const satisfies Record<string, MethodSpec>;

export type AgentExcerpt = z.infer<typeof agentExcerptSchema>;
/* eslint-enable unicorn/max-nested-calls */

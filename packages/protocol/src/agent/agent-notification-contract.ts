import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * Upper bound for `agent.replySummary`; a notification banner shows about two lines, so anything longer is cut anyway.
 */
export const AGENT_REPLY_SUMMARY_MAX_LENGTH = 200;

export const agentNotificationInternalMethods = {
    /**
     * One-line summary of the Primary Agent's latest reply, read on demand from its transcript for the Desktop system
     * notification that announces a finished turn. Internal so only Desktop Main can ask; the text is never persisted,
     * cached, or logged on either side.
     */
    'agent.replySummary': {
        ...commandPolicy('server', 'read'),
        params: z.object({ sessionId: identifierSchema }),
        result: z.object({
            summary: z.string().min(1).max(AGENT_REPLY_SUMMARY_MAX_LENGTH).optional(),
        }),
    },
} as const satisfies Record<string, MethodSpec>;

import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import { sessionRenameTitleSchema } from '../domain/session.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { principalSchema } from '../transport/principal.js';

const sessionTargetSchema = z.strictObject({ sessionId: identifierSchema });
const sessionResultSchema = z.strictObject({ sessionId: identifierSchema });

/**
 * One management step on a Session an Agent created. Archive and restore are the sidebar's own reversible operations;
 * restore puts the Session back at the top of its Project, where the user sees it again.
 */
const agentSessionOperationSchema = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('rename'), title: sessionRenameTitleSchema }),
    z.strictObject({ action: z.literal('archive') }),
    z.strictObject({ action: z.literal('unarchive') }),
]);

/**
 * Lets an Agent tidy up the Sessions its own Session created through `agent delegate create --new-session`: give one a
 * better title, archive it when the work is done, or restore it. Any other Session, including the caller's own and
 * every Session the user created, is `NOT_FOUND`. Caxri Bot is held to the Sessions it still owns, so a Session the
 * user took back or handed over stays out of reach.
 */
export const agentSessionMethods = {
    'agent.session.rename': {
        ...commandPolicy('server', 'control', ['agents.delegate']),
        params: sessionTargetSchema.extend({ title: sessionRenameTitleSchema }),
        result: sessionResultSchema,
    },
    'agent.session.archive': {
        ...commandPolicy('server', 'control', ['agents.delegate']),
        params: sessionTargetSchema,
        result: sessionResultSchema,
    },
    'agent.session.unarchive': {
        ...commandPolicy('server', 'control', ['agents.delegate']),
        params: sessionTargetSchema,
        result: sessionResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

/**
 * Core resolves the caller's Terminal from its authenticated Endpoint; the caller never names its own Session.
 */
export const agentSessionInternalMethods = {
    'agent.session.manageInternal': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({
            principal: principalSchema,
            callerTerminalId: identifierSchema,
            sessionId: identifierSchema,
            operation: agentSessionOperationSchema,
        }),
        result: sessionResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export type AgentSessionOperation = z.infer<typeof agentSessionOperationSchema>;

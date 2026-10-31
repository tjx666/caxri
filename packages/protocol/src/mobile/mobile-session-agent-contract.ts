import { z } from 'zod';

import { agentProviderSchema } from '../agent/agents.js';
import { botHandoverRejectionSchema } from '../agent/bot/caxri-bot-handover-contract.js';
import { identifierSchema } from '../domain/identifiers.js';
import {
    MAX_SESSION_AGENT_HISTORY_ENTRIES,
    sessionReopenConversationParametersSchema,
} from '../domain/session-agent-history.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

const sessionTarget = z.strictObject({ sessionId: identifierSchema });

/**
 * Agent actions from a phone return only the affected identity; the dashboard subscription carries the new state.
 */
const mobileSessionAgentResultSchema = z.strictObject({ sessionId: identifierSchema });

/**
 * One closed conversation the Session's Agents were bound to, which Reopen Conversation can bring back. Only those
 * whose Terminal is gone are listed: a conversation a Terminal still holds is already a tab of the Session.
 */
const mobileReopenableConversationSchema = z.strictObject({
    provider: agentProviderSchema,
    agentSessionId: z.string().min(1).max(1_024),
    title: z.string().max(1_024).optional(),
    boundAt: z.number().int().nonnegative(),
});

/**
 * What the Session menu reads when it opens, the state Desktop's Session row menu also reads on open: neither is part
 * of the dashboard row.
 */
const mobileSessionMenuStateSchema = z.strictObject({
    /**
     * Whether Caxri Bot manages the Session, which decides between Hand Over and Take Back.
     */
    isBotManaged: z.boolean(),
    /**
     * Whether the primary Agent has a provider conversation Restart Agent can resume. The phone never learns the
     * conversation's id, so the Server answers this instead.
     */
    hasConversation: z.boolean(),
    conversations: z
        .array(mobileReopenableConversationSchema)
        .max(MAX_SESSION_AGENT_HISTORY_ENTRIES),
});

/**
 * The Agent actions of Desktop's Session row menu, for a control phone: Restart, Detach and Resume, Hand Over to and
 * Take Back from Caxri Bot, and Reopen Conversation. Each resolves the Session through the device grant first, then
 * calls Desktop's own handler, so a Session outside the grant is `NOT_FOUND` before anything changes.
 */
export const mobileSessionAgentMethods = {
    'mobile.session.menuState': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: sessionTarget,
        result: mobileSessionMenuStateSchema,
    },
    /**
     * Restart Agent: `terminal.restart` in `resume` mode on the Session's primary Agent, so it continues the same
     * conversation. The phone confirms first, since a running turn ends.
     */
    'mobile.session.restartAgent': {
        ...commandPolicy('server', 'control', ['sessions.write']),
        params: sessionTarget,
        result: mobileSessionAgentResultSchema,
    },
    /**
     * Detach Agent through `session.detach`: every Agent of the Session stops so another client can resume its
     * conversation. The phone confirms first, since a running turn ends.
     */
    'mobile.session.detach': {
        ...commandPolicy('server', 'control', ['sessions.write']),
        params: sessionTarget,
        result: mobileSessionAgentResultSchema,
    },
    /**
     * Resume Agent through `session.resume` without a window, so the computer's selected Session stays as it is.
     */
    'mobile.session.resume': {
        ...commandPolicy('server', 'control', ['sessions.write']),
        params: sessionTarget,
        result: mobileSessionAgentResultSchema,
    },
    /**
     * Brings a conversation from `mobile.session.menuState` back as a parked Agent Terminal of the same Session through
     * `session.reopenConversation`.
     */
    'mobile.session.reopenConversation': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: z.strictObject(sessionReopenConversationParametersSchema.shape),
        result: z.strictObject({ sessionId: identifierSchema, terminalId: identifierSchema }),
    },
    /**
     * Hands the Session to Caxri Bot through `bot.session.handOver`, setting Caxri Bot up first as Desktop's Workbench
     * does. A refusal is a result, not an error, so the phone names Desktop's reason.
     */
    'mobile.session.handOverToBot': {
        ...commandPolicy('server', 'control', ['sessions.write']),
        params: sessionTarget,
        result: z.discriminatedUnion('outcome', [
            z.strictObject({ outcome: z.literal('accepted'), sessionId: identifierSchema }),
            z.strictObject({ outcome: z.literal('rejected'), reason: botHandoverRejectionSchema }),
        ]),
    },
    /**
     * Takes the Session back from Caxri Bot through `bot.session.takeBack`; one Caxri Bot no longer manages is a no-op.
     */
    'mobile.session.takeBackFromBot': {
        ...commandPolicy('server', 'control', ['sessions.write']),
        params: sessionTarget,
        result: mobileSessionAgentResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export type MobileSessionMenuState = z.infer<typeof mobileSessionMenuStateSchema>;
export type MobileReopenableConversation = z.infer<typeof mobileReopenableConversationSchema>;

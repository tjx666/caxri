import { z } from 'zod';

import { identifierSchema } from '../../domain/identifiers.js';

const POINTER =
    /^Read the delegated task from ("(?:[^"\\]|\\.)*") and carry it out\. Delegation ID: ([\w-]+)\.$/u;

/**
 * Where a delegated task came from: the Session whose Agent delegated it, or Caxri Bot. Absent when the caller is gone
 * or was not an Agent Terminal.
 */
const agentChatDelegatedTaskSourceSchema = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('session'), sessionId: identifierSchema }),
    z.strictObject({ kind: z.literal('bot') }),
]);

/**
 * A user message that is really a delegated task pointer, which Server Core recognizes so Clients can say which Session
 * sent it, and what it asked, instead of showing the pointer as if the user had typed it.
 */
export const agentChatDelegatedTaskSchema = z.strictObject({
    delegationId: identifierSchema,
    source: agentChatDelegatedTaskSourceSchema.optional(),
    /**
     * The task the caller wrote, from the delegation record; the pointer itself only names the private file holding it.
     * Absent when the record is gone.
     */
    prompt: z.string().max(16_384).optional(),
    /**
     * The task continues the source Session's work, which handed it off with `/new-session`; see
     * `agentDelegationCreateRequestSchema`'s `handoff`.
     */
    handoff: z.literal(true).optional(),
    /**
     * The task started a separate Session the caller does not wait on (`independent`), so the message reads "Started
     * by" its creator rather than "Delegated by".
     */
    independent: z.literal(true).optional(),
    /**
     * The message is a redirect of a running task (`agent.delegation.redirect`), not the task itself. `prompt` then
     * holds the new direction; the message steered the task's own turn and is no takeover.
     */
    redirect: z.literal(true).optional(),
});

export type AgentChatDelegatedTask = z.infer<typeof agentChatDelegatedTaskSchema>;
export type AgentChatDelegatedTaskSource = z.infer<typeof agentChatDelegatedTaskSourceSchema>;

/**
 * The first message of a delegated task (or a follow-up to one): only this opaque pointer reaches the Agent's argv or
 * Chat, while the task body stays in the private profile at `taskPath`.
 */
export function delegatedTaskPointer(taskPath: string, delegationId: string): string {
    return `Read the delegated task from ${JSON.stringify(taskPath)} and carry it out. Delegation ID: ${delegationId}.`;
}

const REDIRECT =
    /^Updated direction from the Agent that delegated this task \(Delegation ID: ([\w-]+), Operation ID: ([\w-]+)\):\n\n([\s\S]+)$/u;

/**
 * The message that steers a running delegated task: the new direction inline, tagged with the task and the redirect
 * operation so the Chat and the transcript can tell it from anything a person typed.
 */
export function delegatedRedirectMessage(
    delegationId: string,
    operationId: string,
    text: string,
): string {
    return `Updated direction from the Agent that delegated this task (Delegation ID: ${delegationId}, Operation ID: ${operationId}):\n\n${text}`;
}

/**
 * Reads a message back as a {@link delegatedRedirectMessage}; `undefined` for anything else, including a task pointer.
 */
export function parseDelegatedRedirect(
    text: string,
): { delegationId: string; operationId: string; text: string } | undefined {
    const match = REDIRECT.exec(text.trim());
    return match ? { delegationId: match[1], operationId: match[2], text: match[3] } : undefined;
}

/**
 * Reads a message back as a {@link delegatedTaskPointer}; `undefined` for anything else.
 */
export function parseDelegatedTaskPointer(
    text: string,
): { taskPath: string; delegationId: string } | undefined {
    const match = POINTER.exec(text.trim());
    if (!match) return undefined;
    try {
        const taskPath: unknown = JSON.parse(match[1]);
        return typeof taskPath === 'string' ? { taskPath, delegationId: match[2] } : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Most items one delivered settlement notice lists (`SettlementNotices` sends no more per message).
 */
export const MAX_DELEGATION_NOTICE_ITEMS = 32;

/**
 * What a settlement notice reports about one delegated task, as a closed set the Client turns into a status word.
 */
export const delegationNoticeEventSchema = z.enum([
    'completed',
    'failed',
    'interrupted',
    'taken_over',
    'answer_unavailable',
    'settled',
    'handed_back',
    'question',
    'approval',
]);

export type DelegationNoticeEvent = z.infer<typeof delegationNoticeEventSchema>;

/**
 * How loudly a Client draws an event's icon, the same on Desktop and the phone: a failure is red, what waits on the
 * user amber, everything else quiet.
 */
export function delegationNoticeEventTone(
    event: DelegationNoticeEvent,
): 'danger' | 'muted' | 'warning' {
    switch (event) {
        case 'failed':
        case 'answer_unavailable': {
            return 'danger';
        }
        case 'question':
        case 'approval': {
            return 'warning';
        }
        default: {
            return 'muted';
        }
    }
}

/**
 * A user message that is really a settlement notice Caxri delivered to the delegating Agent's Chat (a task settled,
 * asked a question, needs approval, or was handed back). Server Core stamps it only when the text matches a notice it
 * delivered to this Terminal, so a person who types the same words keeps a plain bubble. The items hold IDs and a
 * closed event only: the Client joins the child Session's title from its own Session data, never from the message.
 */
export interface AgentChatDelegationNotice {
    items: Array<{ delegationId: string; sessionId: string; event: DelegationNoticeEvent }>;
}

/**
 * Annotated with {@link AgentChatDelegationNotice} rather than inferred: the Chat item schema is embedded in many method
 * specs, and the inferred object type pushed the method registry's declaration past the compiler's serialization
 * limit.
 */
export const agentChatDelegationNoticeSchema: z.ZodType<AgentChatDelegationNotice> = z.strictObject(
    {
        items: z
            .array(
                z.strictObject({
                    delegationId: identifierSchema,
                    sessionId: identifierSchema,
                    event: delegationNoticeEventSchema,
                }),
            )
            .min(1)
            .max(MAX_DELEGATION_NOTICE_ITEMS),
    },
);

/**
 * Most delegations one command item records.
 */
export const MAX_COMMAND_DELEGATIONS = 8;

/**
 * The delegations a Chat command created: the task and the Session it runs in. IDs only, so the stamp is safe in
 * projections, history, and fixtures.
 */
export const agentChatCommandDelegationsSchema = z
    .array(z.strictObject({ delegationId: identifierSchema, sessionId: identifierSchema }))
    .min(1)
    .max(MAX_COMMAND_DELEGATIONS);

export type AgentChatCommandDelegation = z.infer<typeof agentChatCommandDelegationsSchema>[number];

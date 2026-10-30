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

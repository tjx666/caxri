/* eslint-disable unicorn/max-nested-calls -- Declarative Zod schemas intentionally compose bounded validators inline. */
import { z } from 'zod';

/**
 * Questions one Agent Chat question request may ask at once.
 */
export const MAX_AGENT_CHAT_QUESTIONS = 10;

export const agentChatDecisionSchema = z.enum(['accept', 'acceptForSession', 'decline', 'cancel']);

/**
 * Fields shared by approvals. `itemId` links the approval to the timeline item it gates (the command or file change),
 * so a card can show what it would change. `decisions`, when the provider lists them, are the only choices it accepts.
 */
const approvalBase = {
    id: z.string().min(1).max(200),
    itemId: z.string().min(1).max(200).optional(),
    reason: z.string().max(2_000).optional(),
    decisions: z.array(agentChatDecisionSchema).max(4).optional(),
};

/**
 * A provider request waiting for the user. `id` is Caxri's stable key for the request (the provider item id), not the
 * transport request id, because a provider may re-send a pending request with a new transport id after a resume.
 */
export const agentChatRequestSchema = z.discriminatedUnion('kind', [
    z.strictObject({
        ...approvalBase,
        kind: z.literal('command'),
        command: z.string().max(4_096).optional(),
        cwd: z.string().max(4_096).optional(),
        /**
         * Host a sandboxed command asks to reach, when the approval is for network access rather than the command.
         */
        networkHost: z.string().max(500).optional(),
    }),
    z.strictObject({
        ...approvalBase,
        kind: z.literal('fileChange'),
    }),
    /**
     * Any other tool the provider asks before running (a web fetch, an MCP tool), for providers that gate tools rather
     * than only commands and file changes.
     */
    z.strictObject({
        ...approvalBase,
        kind: z.literal('tool'),
        /**
         * Provider tool name, such as `WebFetch` or an MCP `server__tool` pair.
         */
        name: z.string().max(200),
        /**
         * What the tool would act on: a URL, a query, or a bounded preview of its arguments.
         */
        summary: z.string().max(4_096).optional(),
    }),
    z.strictObject({
        id: z.string().min(1).max(200),
        kind: z.literal('question'),
        questions: z
            .array(
                z.strictObject({
                    id: z.string().min(1).max(200),
                    header: z.string().max(200),
                    question: z.string().max(2_000),
                    options: z
                        .array(
                            z.strictObject({
                                label: z.string().max(200),
                                description: z.string().max(1_000),
                            }),
                        )
                        .max(20),
                    allowsOther: z.boolean(),
                    /**
                     * The user may pick several options; the answer lists every one. Absent means one option.
                     */
                    multiSelect: z.boolean().optional(),
                }),
            )
            .max(MAX_AGENT_CHAT_QUESTIONS),
    }),
]);

export type AgentChatRequest = z.infer<typeof agentChatRequestSchema>;
export type AgentChatDecision = z.infer<typeof agentChatDecisionSchema>;
/* eslint-enable unicorn/max-nested-calls */

/* eslint-disable unicorn/max-nested-calls -- Declarative Zod schemas intentionally compose bounded validators inline. */
import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import { agentChatItemSchema, agentChatTaskSchema } from './agent-chat-contract.js';
import {
    MAX_AGENT_CHAT_OUTPUT_LENGTH,
    MAX_AGENT_CHAT_PATCH_OPERATIONS,
    MAX_AGENT_CHAT_TASK_ITEMS,
    MAX_AGENT_CHAT_TEXT_LENGTH,
} from './agent-chat-limits.js';

const boundedOutput = z.string().max(MAX_AGENT_CHAT_OUTPUT_LENGTH);

/**
 * The conversation of one task: a subagent's own messages and tool rows, or a background shell's output tail. Kept
 * apart from the parent projection with its own revisions and budget.
 */
export const agentChatTaskSnapshotSchema = z.strictObject({
    terminalId: identifierSchema,
    taskId: agentChatTaskSchema.shape.id,
    revision: z.number().int().nonnegative(),
    truncated: z.boolean(),
    items: z.array(agentChatItemSchema).max(MAX_AGENT_CHAT_TASK_ITEMS),
    /**
     * Tail of a background shell's output.
     */
    output: boundedOutput.optional(),
    /**
     * Set when the provider stopped streaming this shell's output (Codex caps the deltas of one command), so the tab
     * says the output is no longer live instead of looking idle.
     */
    isOutputCapped: z.boolean().optional(),
});

const agentChatTaskPatchOperationSchema = z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('upsertItem'), item: agentChatItemSchema }),
    z.strictObject({
        op: z.literal('appendText'),
        itemId: z.string().min(1).max(200),
        delta: z.string().max(MAX_AGENT_CHAT_TEXT_LENGTH),
    }),
    z.strictObject({
        op: z.literal('appendOutput'),
        delta: z.string().max(MAX_AGENT_CHAT_TEXT_LENGTH),
    }),
    z.strictObject({
        op: z.literal('state'),
        state: z
            .strictObject({
                output: boundedOutput,
                isOutputCapped: z.boolean(),
                truncated: z.boolean(),
            })
            .partial(),
    }),
    z.strictObject({ op: z.literal('reset') }),
]);

export const agentChatTaskPatchSchema = z.strictObject({
    terminalId: identifierSchema,
    taskId: agentChatTaskSchema.shape.id,
    baseRevision: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    operations: z
        .array(agentChatTaskPatchOperationSchema)
        .min(1)
        .max(MAX_AGENT_CHAT_PATCH_OPERATIONS),
});

export type AgentChatTaskSnapshot = z.infer<typeof agentChatTaskSnapshotSchema>;
export type AgentChatTaskPatchOperation = z.infer<typeof agentChatTaskPatchOperationSchema>;
export type AgentChatTaskPatch = z.infer<typeof agentChatTaskPatchSchema>;
/* eslint-enable unicorn/max-nested-calls */

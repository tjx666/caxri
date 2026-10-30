/* eslint-disable unicorn/max-nested-calls -- Declarative Zod schemas intentionally compose bounded validators inline. */
import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import {
    agentChatItemSchema,
    agentChatSnapshotSchema,
    agentChatTurnSchema,
} from './agent-chat-contract.js';
import {
    MAX_AGENT_CHAT_HISTORY_PAGE_ITEMS,
    MAX_AGENT_CHAT_PATCH_OPERATIONS,
    MAX_AGENT_CHAT_TEXT_LENGTH,
} from './agent-chat-limits.js';

/**
 * One incremental change. `upsertItem` replaces an item by id (appending when new); `appendText` streams a delta into a
 * message, reasoning, or command output; `state` replaces the scalar parts of the snapshot that changed.
 */
const agentChatPatchOperationSchema = z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('upsertItem'), item: agentChatItemSchema }),
    z.strictObject({
        op: z.literal('appendText'),
        itemId: z.string().min(1).max(200),
        delta: z.string().max(MAX_AGENT_CHAT_TEXT_LENGTH),
    }),
    z.strictObject({
        op: z.literal('state'),
        /**
         * Present keys replace their snapshot value; `null` clears an optional one (JSON cannot carry `undefined`).
         */
        state: z
            .strictObject({
                status: agentChatSnapshotSchema.shape.status,
                failure: agentChatSnapshotSchema.shape.failure.unwrap().nullable(),
                turns: agentChatSnapshotSchema.shape.turns,
                activeTurnId: agentChatSnapshotSchema.shape.activeTurnId.unwrap().nullable(),
                requests: agentChatSnapshotSchema.shape.requests,
                plan: agentChatSnapshotSchema.shape.plan.unwrap().nullable(),
                goal: agentChatSnapshotSchema.shape.goal.unwrap().nullable(),
                goalUsage: agentChatSnapshotSchema.shape.goalUsage.unwrap().nullable(),
                model: agentChatSnapshotSchema.shape.model.unwrap().nullable(),
                effort: agentChatSnapshotSchema.shape.effort.unwrap().nullable(),
                ultracode: agentChatSnapshotSchema.shape.ultracode.unwrap().nullable(),
                fast: agentChatSnapshotSchema.shape.fast.unwrap().nullable(),
                permissionMode: agentChatSnapshotSchema.shape.permissionMode.unwrap().nullable(),
                planMode: agentChatSnapshotSchema.shape.planMode.unwrap().nullable(),
                models: agentChatSnapshotSchema.shape.models.unwrap(),
                commands: agentChatSnapshotSchema.shape.commands.unwrap(),
                mcpServers: agentChatSnapshotSchema.shape.mcpServers.unwrap(),
                usage: agentChatSnapshotSchema.shape.usage.unwrap().nullable(),
                turnUsage: agentChatSnapshotSchema.shape.turnUsage.unwrap().nullable(),
                truncated: agentChatSnapshotSchema.shape.truncated,
                historyId: agentChatSnapshotSchema.shape.historyId.unwrap(),
                operation: agentChatSnapshotSchema.shape.operation.unwrap().nullable(),
                tasks: agentChatSnapshotSchema.shape.tasks.unwrap(),
                queue: agentChatSnapshotSchema.shape.queue.unwrap(),
                queueLength: agentChatSnapshotSchema.shape.queueLength.unwrap(),
                queuePaused: agentChatSnapshotSchema.shape.queuePaused.unwrap(),
                queuePauseReason: agentChatSnapshotSchema.shape.queuePauseReason
                    .unwrap()
                    .nullable(),
                usageGuard: agentChatSnapshotSchema.shape.usageGuard.unwrap().nullable(),
            })
            .partial(),
    }),
    z.strictObject({ op: z.literal('reset') }),
]);

/**
 * One page of older history: the items right before the Client's oldest one, oldest first, with the turns they belong
 * to. `hasMore` asks for the next page with this page's oldest item; once it is false, `truncated` says whether the
 * conversation still goes back further than Chat can show (the provider's record is the only full copy).
 */
export const agentChatHistoryPageSchema = z.strictObject({
    historyId: agentChatSnapshotSchema.shape.historyId.unwrap(),
    items: z.array(agentChatItemSchema).max(MAX_AGENT_CHAT_HISTORY_PAGE_ITEMS),
    turns: z.array(agentChatTurnSchema).max(MAX_AGENT_CHAT_HISTORY_PAGE_ITEMS),
    hasMore: z.boolean(),
    truncated: z.boolean(),
});

export const agentChatPatchSchema = z.strictObject({
    terminalId: identifierSchema,
    baseRevision: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
    operations: z.array(agentChatPatchOperationSchema).min(1).max(MAX_AGENT_CHAT_PATCH_OPERATIONS),
});

export type AgentChatPatchOperation = z.infer<typeof agentChatPatchOperationSchema>;
export type AgentChatPatch = z.infer<typeof agentChatPatchSchema>;
export type AgentChatHistoryPage = z.infer<typeof agentChatHistoryPageSchema>;
/* eslint-enable unicorn/max-nested-calls */

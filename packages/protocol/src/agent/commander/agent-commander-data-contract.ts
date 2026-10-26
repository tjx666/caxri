import { z } from 'zod';

import { canceledResultSchema, identifierSchema } from '../../domain/domain.js';
import type { MethodSpec } from '../../transport/method-spec.js';
import { commandPolicy } from '../../transport/method-spec.js';
import type { AgentProvider } from '../agents.js';
import {
    commanderSnapshotSchema,
    commanderTaskSchema,
    MAX_COMMANDER_TASKS,
} from './agent-commander-contract.js';

/**
 * Agent CLIs that can run the Agent Commander. Both read the generated workspace `AGENTS.md` natively (Claude Code
 * falls back to it when no `CLAUDE.md` exists), drive Session activity through their lifecycle hooks, and take
 * delegation notices as typed input, so the Commander needs no provider-specific path beyond its launch preparation.
 * Grok Build is absent: its workspace sandbox requirement has no Commander precedent yet.
 */
export const commanderAgentIds = ['codex', 'claude'] as const satisfies readonly AgentProvider[];
export const commanderAgentSchema = z.enum(commanderAgentIds);
export type CommanderAgent = z.infer<typeof commanderAgentSchema>;

/**
 * The Agent a Commander starts with until the user switches it.
 */
export const DEFAULT_COMMANDER_AGENT: CommanderAgent = 'codex';

/**
 * One of the three long-term memory files in the Commander workspace's `memory/` directory. `isTemplate` is true when
 * the file still holds exactly the template Caxri seeded, so the dialog can say there is nothing learned to clear.
 */
export const commanderMemoryFileSchema = z.strictObject({
    name: z.string().min(1).max(64),
    bytes: z.number().int().nonnegative(),
    isTemplate: z.boolean(),
});

/**
 * Content-free sizes of everything Clear Commander Data can remove, read when the dialog opens. Task titles are the
 * Commander's own bookkeeping, already shown on the board; no task note, Inbox body, memory text, or file name leaves
 * the Server.
 */
export const commanderDataSummarySchema = z.strictObject({
    /**
     * Open tasks oldest first, then the most recently closed, as `commander task list --all` returns them, up to
     * `MAX_COMMANDER_TASKS`. `taskCount` counts every row, so the dialog can say how many older ones it does not list.
     */
    tasks: z.array(commanderTaskSchema).max(MAX_COMMANDER_TASKS),
    taskCount: z.number().int().nonnegative(),
    memory: z.array(commanderMemoryFileSchema).max(16),
    /**
     * Files the Commander wrote under `tasks/` and `reports/`: one brief per delegation and one report per pull
     * request.
     */
    taskFiles: z.strictObject({
        count: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative(),
    }),
    inbox: z.strictObject({
        open: z.number().int().nonnegative(),
        closed: z.number().int().nonnegative(),
    }),
    /**
     * The Agent the Commander Terminal runs, and whether it holds a conversation a reset would end.
     */
    conversation: z.strictObject({
        agent: commanderAgentSchema,
        isBound: z.boolean(),
    }),
});
export type CommanderDataSummary = z.infer<typeof commanderDataSummarySchema>;

/**
 * Which ledger rows Clear Commander Data deletes: every one, every closed one (`done` or `dropped`, including those
 * older than the dialog lists), or the listed ones.
 */
export const commanderTaskDeleteScopeSchema = z.union([
    z.enum(['all', 'closed']),
    z.array(identifierSchema).min(1).max(MAX_COMMANDER_TASKS),
]);
export type CommanderTaskDeleteScope = z.infer<typeof commanderTaskDeleteScopeSchema>;

/**
 * Which Commander data to clear. Every field is opt-in, so a request names exactly what the user ticked.
 *
 * - `tasks`: the ledger rows {@link commanderTaskDeleteScopeSchema} names. Delegation receipts stay with their Sessions.
 * - `memory`: resets `memory/` to its templates.
 * - `taskFiles`: deletes everything under `tasks/` and `reports/`.
 * - `inbox`: deletes every Commander Inbox item, open or closed, with its replies.
 * - `instructions`: rewrites `AGENTS.md` from Caxri's template and the memory that remains.
 * - `conversation`: restarts the Commander on a new conversation, ending the current turn.
 */
export const commanderClearDataSchema = z.strictObject({
    tasks: commanderTaskDeleteScopeSchema.optional(),
    memory: z.boolean().optional(),
    taskFiles: z.boolean().optional(),
    inbox: z.boolean().optional(),
    instructions: z.boolean().optional(),
    conversation: z.boolean().optional(),
});
export type CommanderClearData = z.infer<typeof commanderClearDataSchema>;

export const commanderClearDataResultSchema = z.strictObject({
    tasksDeleted: z.number().int().nonnegative(),
    memoryReset: z.boolean(),
    taskFilesDeleted: z.number().int().nonnegative(),
    inboxItemsDeleted: z.number().int().nonnegative(),
    instructionsRewritten: z.boolean(),
    conversationReset: z.boolean(),
});
export type CommanderClearDataResult = z.infer<typeof commanderClearDataResultSchema>;

/**
 * Public Commander data methods. `commander.switchAgent` keeps the Commander Terminal's identity, so every task it
 * delegated before stays its own; only the conversation starts over. Clearing data is destructive, so the window asks
 * Desktop Main (`agentCommander.clearData`), which shows the native confirmation before it forwards the internal
 * `commander.clearData`.
 */
export const commanderDataMethods = {
    'commander.data': {
        ...commandPolicy('server', 'read'),
        params: z.object({}).default({}),
        result: commanderDataSummarySchema,
    },
    'commander.switchAgent': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({ agent: commanderAgentSchema }),
        result: commanderSnapshotSchema,
    },
    'agentCommander.clearData': {
        ...commandPolicy('desktop', 'write'),
        params: commanderClearDataSchema,
        result: z.union([canceledResultSchema, commanderClearDataResultSchema]),
    },
} as const satisfies Record<string, MethodSpec>;

/**
 * Reached only through Desktop Main after the user confirmed `agentCommander.clearData`.
 */
export const commanderDataInternalMethods = {
    'commander.clearData': {
        ...commandPolicy('server', 'write'),
        params: commanderClearDataSchema,
        result: commanderClearDataResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

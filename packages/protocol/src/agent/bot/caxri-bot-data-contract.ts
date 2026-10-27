import { z } from 'zod';

import { canceledResultSchema, identifierSchema } from '../../domain/domain.js';
import type { MethodSpec } from '../../transport/method-spec.js';
import { commandPolicy } from '../../transport/method-spec.js';
import type { AgentProvider } from '../agents.js';
import { botSnapshotSchema, botTaskSchema, MAX_BOT_TASKS } from './caxri-bot-contract.js';

/**
 * Agent CLIs that can run Caxri Bot. Both read the generated workspace `AGENTS.md` natively (Claude Code falls back to
 * it when no `CLAUDE.md` exists), drive Session activity through their lifecycle hooks, and take delegation notices as
 * typed input, so Caxri Bot needs no provider-specific path beyond its launch preparation. Grok Build is absent: its
 * workspace sandbox requirement has no precedent in Caxri Bot yet.
 */
export const botAgentIds = ['codex', 'claude'] as const satisfies readonly AgentProvider[];
export const botAgentSchema = z.enum(botAgentIds);
export type BotAgent = z.infer<typeof botAgentSchema>;

/**
 * The Agent a Caxri Bot starts with until the user switches it.
 */
export const DEFAULT_BOT_AGENT: BotAgent = 'codex';

/**
 * One of the three long-term memory files in Caxri Bot's workspace's `memory/` directory. `isTemplate` is true when the
 * file still holds exactly the template Caxri seeded, so the dialog can say there is nothing learned to clear.
 */
export const botMemoryFileSchema = z.strictObject({
    name: z.string().min(1).max(64),
    bytes: z.number().int().nonnegative(),
    isTemplate: z.boolean(),
});

/**
 * Content-free sizes of everything Clear Caxri Bot Data can remove, read when the dialog opens. Task titles are the
 * Caxri Bot's own bookkeeping, already shown on the board; no task note, Inbox body, memory text, or file name leaves
 * the Server.
 */
export const botDataSummarySchema = z.strictObject({
    /**
     * Open tasks oldest first, then the most recently closed, as `bot task list --all` returns them, up to
     * `MAX_BOT_TASKS`. `taskCount` counts every row, so the dialog can say how many older ones it does not list.
     */
    tasks: z.array(botTaskSchema).max(MAX_BOT_TASKS),
    taskCount: z.number().int().nonnegative(),
    memory: z.array(botMemoryFileSchema).max(16),
    /**
     * Files Caxri Bot wrote under `tasks/` and `reports/`: one brief per delegation and one report per pull request.
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
     * The Agent Caxri Bot's Terminal runs, and whether it holds a conversation a reset would end.
     */
    conversation: z.strictObject({
        agent: botAgentSchema,
        isBound: z.boolean(),
    }),
});
export type BotDataSummary = z.infer<typeof botDataSummarySchema>;

/**
 * Which ledger rows Clear Caxri Bot Data deletes: every one, every closed one (`done` or `dropped`, including those
 * older than the dialog lists), or the listed ones.
 */
export const botTaskDeleteScopeSchema = z.union([
    z.enum(['all', 'closed']),
    z.array(identifierSchema).min(1).max(MAX_BOT_TASKS),
]);
export type BotTaskDeleteScope = z.infer<typeof botTaskDeleteScopeSchema>;

/**
 * Which Caxri Bot data to clear. Every field is opt-in, so a request names exactly what the user ticked.
 *
 * - `tasks`: the ledger rows {@link botTaskDeleteScopeSchema} names. Delegation receipts stay with their Sessions.
 * - `memory`: resets `memory/` to its templates.
 * - `taskFiles`: deletes everything under `tasks/` and `reports/`.
 * - `inbox`: deletes every Bot Inbox item, open or closed, with its replies.
 * - `instructions`: rewrites `AGENTS.md` from Caxri's template and the memory that remains.
 * - `conversation`: restarts Caxri Bot on a new conversation, ending the current turn.
 */
export const botClearDataSchema = z.strictObject({
    tasks: botTaskDeleteScopeSchema.optional(),
    memory: z.boolean().optional(),
    taskFiles: z.boolean().optional(),
    inbox: z.boolean().optional(),
    instructions: z.boolean().optional(),
    conversation: z.boolean().optional(),
});
export type BotClearData = z.infer<typeof botClearDataSchema>;

export const botClearDataResultSchema = z.strictObject({
    tasksDeleted: z.number().int().nonnegative(),
    memoryReset: z.boolean(),
    taskFilesDeleted: z.number().int().nonnegative(),
    inboxItemsDeleted: z.number().int().nonnegative(),
    instructionsRewritten: z.boolean(),
    conversationReset: z.boolean(),
});
export type BotClearDataResult = z.infer<typeof botClearDataResultSchema>;

/**
 * Public Caxri Bot data methods. `bot.switchAgent` keeps the Caxri Bot Terminal's identity, so every task it delegated
 * before stays its own; only the conversation starts over. Clearing data is destructive, so the window asks Desktop
 * Main (`caxriBot.clearData`), which shows the native confirmation before it forwards the internal `bot.clearData`.
 */
export const botDataMethods = {
    'bot.data': {
        ...commandPolicy('server', 'read'),
        params: z.object({}).default({}),
        result: botDataSummarySchema,
    },
    'bot.switchAgent': {
        ...commandPolicy('server', 'control'),
        params: z.strictObject({ agent: botAgentSchema }),
        result: botSnapshotSchema,
    },
    'caxriBot.clearData': {
        ...commandPolicy('desktop', 'write'),
        params: botClearDataSchema,
        result: z.union([canceledResultSchema, botClearDataResultSchema]),
    },
} as const satisfies Record<string, MethodSpec>;

/**
 * Reached only through Desktop Main after the user confirmed `caxriBot.clearData`.
 */
export const botDataInternalMethods = {
    'bot.clearData': {
        ...commandPolicy('server', 'write'),
        params: botClearDataSchema,
        result: botClearDataResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

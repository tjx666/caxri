import type { BotAgent, BotClearData, BotClearDataResult, BotDataSummary } from '@caxri/protocol';
import { botAgentSchema, DEFAULT_BOT_AGENT } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import { caxriBotTerminal } from '../db';
import type { BotHandoverService } from './handover';
import type { BotInboxService } from './inbox';
import { clearBotTaskFiles } from './task-files';
import { botWorkspacePath, inspectBotWorkspace, resetBotMemory } from './workspace';

export interface BotDataStores {
    database: CaxriDatabase;
    handovers: Pick<BotHandoverService, 'forgetClearedTasks'>;
    inbox: Pick<BotInboxService, 'clear' | 'counts'>;
    userDataPath: string;
}

/**
 * The Agent Caxri Bot runs: its Terminal's provider once one exists, so the answer always matches the process the user
 * sees, and otherwise the stored choice the next start uses.
 */
export function botAgent(database: CaxriDatabase): BotAgent {
    const identity = caxriBotTerminal(database);
    const provider = identity && database.getTerminal(identity.terminalId)?.provider;
    const running = botAgentSchema.safeParse(provider);
    if (running.success) return running.data;
    return database.getAppState('botAgent') ?? DEFAULT_BOT_AGENT;
}

/**
 * Sizes of everything Clear Caxri Bot Data can remove. Reads only: a missing workspace reports nothing to clear.
 */
export async function readBotData({
    database,
    inbox,
    userDataPath,
}: BotDataStores): Promise<BotDataSummary> {
    const identity = caxriBotTerminal(database);
    const terminal = identity && database.getTerminal(identity.terminalId);
    return {
        tasks: database.botTasks.list({ includeClosed: true }),
        taskCount: database.botTasks.countAll(),
        ...(await inspectBotWorkspace(botWorkspacePath(userDataPath))),
        inbox: inbox.counts(),
        conversation: {
            agent: botAgent(database),
            isBound: Boolean(terminal?.agentSessionId),
        },
    };
}

/**
 * Clears the ledger, Inbox, and workspace data a request names. The conversation and `AGENTS.md` are the caller's: the
 * first needs Caxri Bot process, and the second must follow a memory reset.
 *
 * A deleted task of a hand-over Caxri Bot has not continued takes the hand-over with it: its note lived on the task,
 * and the dialog promises Caxri Bot stops following a deleted task.
 */
export async function clearBotStores(
    { database, handovers, inbox, userDataPath }: BotDataStores,
    request: BotClearData,
): Promise<
    Pick<
        BotClearDataResult,
        'inboxItemsDeleted' | 'memoryReset' | 'taskFilesDeleted' | 'tasksDeleted'
    > & { handoversForgotten: number }
> {
    const workspacePath = botWorkspacePath(userDataPath);
    const tasksDeleted = request.tasks ? database.botTasks.delete(request.tasks) : 0;
    const handoversForgotten = tasksDeleted > 0 ? handovers.forgetClearedTasks() : 0;
    const inboxItemsDeleted = request.inbox ? inbox.clear() : 0;
    const [taskFilesDeleted] = await Promise.all([
        request.taskFiles ? clearBotTaskFiles(workspacePath) : 0,
        request.memory && resetBotMemory(workspacePath),
    ]);
    return {
        tasksDeleted,
        handoversForgotten,
        inboxItemsDeleted,
        taskFilesDeleted,
        memoryReset: request.memory === true,
    };
}

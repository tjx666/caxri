import type {
    CommanderAgent,
    CommanderClearData,
    CommanderClearDataResult,
    CommanderDataSummary,
} from '@caxri/protocol';
import { commanderAgentSchema, DEFAULT_COMMANDER_AGENT } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import { agentCommanderTerminal } from '../db';
import type { CommanderHandoverService } from './handover';
import type { CommanderInboxService } from './inbox';
import {
    clearCommanderTaskFiles,
    commanderWorkspacePath,
    inspectCommanderWorkspace,
    resetCommanderMemory,
} from './workspace';

export interface CommanderDataStores {
    database: CaxriDatabase;
    handovers: Pick<CommanderHandoverService, 'forgetClearedTasks'>;
    inbox: Pick<CommanderInboxService, 'clear' | 'counts'>;
    userDataPath: string;
}

/**
 * The Agent the Commander runs: its Terminal's provider once one exists, so the answer always matches the process the
 * user sees, and otherwise the stored choice the next start uses.
 */
export function commanderAgent(database: CaxriDatabase): CommanderAgent {
    const identity = agentCommanderTerminal(database);
    const provider = identity && database.getTerminal(identity.terminalId)?.provider;
    const running = commanderAgentSchema.safeParse(provider);
    if (running.success) return running.data;
    return database.getAppState('commanderAgent') ?? DEFAULT_COMMANDER_AGENT;
}

/**
 * Sizes of everything Clear Commander Data can remove. Reads only: a missing workspace reports nothing to clear.
 */
export async function readCommanderData({
    database,
    inbox,
    userDataPath,
}: CommanderDataStores): Promise<CommanderDataSummary> {
    const identity = agentCommanderTerminal(database);
    const terminal = identity && database.getTerminal(identity.terminalId);
    return {
        tasks: database.commanderTasks.list({ includeClosed: true }),
        taskCount: database.commanderTasks.countAll(),
        ...(await inspectCommanderWorkspace(commanderWorkspacePath(userDataPath))),
        inbox: inbox.counts(),
        conversation: {
            agent: commanderAgent(database),
            isBound: Boolean(terminal?.agentSessionId),
        },
    };
}

/**
 * Clears the ledger, Inbox, and workspace data a request names. The conversation and `AGENTS.md` are the caller's: the
 * first needs the Commander process, and the second must follow a memory reset.
 *
 * A deleted task of a hand-over the Commander has not continued takes the hand-over with it: its note lived on the
 * task, and the dialog promises the Commander stops following a deleted task.
 */
export async function clearCommanderStores(
    { database, handovers, inbox, userDataPath }: CommanderDataStores,
    request: CommanderClearData,
): Promise<
    Pick<
        CommanderClearDataResult,
        'inboxItemsDeleted' | 'memoryReset' | 'taskFilesDeleted' | 'tasksDeleted'
    > & { handoversForgotten: number }
> {
    const workspacePath = commanderWorkspacePath(userDataPath);
    const tasksDeleted = request.tasks ? database.commanderTasks.delete(request.tasks) : 0;
    const handoversForgotten = tasksDeleted > 0 ? handovers.forgetClearedTasks() : 0;
    const inboxItemsDeleted = request.inbox ? inbox.clear() : 0;
    const [taskFilesDeleted] = await Promise.all([
        request.taskFiles ? clearCommanderTaskFiles(workspacePath) : 0,
        request.memory && resetCommanderMemory(workspacePath),
    ]);
    return {
        tasksDeleted,
        handoversForgotten,
        inboxItemsDeleted,
        taskFilesDeleted,
        memoryReset: request.memory === true,
    };
}

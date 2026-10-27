import type { AgentChatService } from './agent-chat';
import { createBackgroundTasks } from './background-tasks';
import type { FileService } from './files';
import type { GitService } from './git';
import type { TerminalRestoreSupervisor, TerminalSuspensionService } from './terminal';
import { createBotTerminalRestorer, createInterruptedTerminalRestorer } from './terminal';

type RestorerOptions = Parameters<typeof createBotTerminalRestorer>[0];

/**
 * Owns the Terminal restore slice. Create: the interrupted-Terminal restorers for the user's Sessions and the Agent
 * Caxri Bot's, each behind its fire-and-forget background wrapper. Start: registers the suspension service's reselect
 * hook so a reselected suspended Session restores. Close: the composition root closes the returned `botRestores` after
 * `terminalRestores`, in its fixed close order.
 */
export function createRestoreServices(options: {
    agentChat: Pick<AgentChatService, 'resumeSuspended'>;
    files: FileService;
    git: GitService;
    restorerOptions: RestorerOptions;
    terminalRestores: TerminalRestoreSupervisor;
    terminalSuspension: Pick<TerminalSuspensionService, 'setOnSuspendedSessionReselected'>;
}) {
    const { agentChat, files, git, restorerOptions, terminalRestores, terminalSuspension } =
        options;
    const { logger } = restorerOptions;
    const restoreInterruptedTerminals = createInterruptedTerminalRestorer({
        ...restorerOptions,
        terminalRestores,
    });
    const { restoreInterruptedTerminalsInBackground, watchSessionInBackground } =
        createBackgroundTasks(logger, files, git, async (sessionId, restoreOptions) => {
            agentChat.resumeSuspended(sessionId);
            await restoreInterruptedTerminals(sessionId, restoreOptions);
        });
    terminalSuspension.setOnSuspendedSessionReselected(restoreInterruptedTerminalsInBackground);
    const { restore: restoreBot, supervisor: botRestores } =
        createBotTerminalRestorer(restorerOptions);
    const restoreBotTerminals = createBackgroundTasks(
        logger,
        files,
        git,
        restoreBot,
    ).restoreInterruptedTerminalsInBackground;
    return {
        botRestores,
        restoreBotTerminals,
        restoreInterruptedTerminalsInBackground,
        watchSessionInBackground,
    };
}

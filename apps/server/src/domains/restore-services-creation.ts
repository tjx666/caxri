import type { AgentChatService } from './agent-chat';
import { createBackgroundTasks } from './background-tasks';
import type { FileService } from './files';
import type { GitService } from './git';
import type { TerminalRestoreSupervisor, TerminalSuspensionService } from './terminal';
import { createCommanderTerminalRestorer, createInterruptedTerminalRestorer } from './terminal';

type RestorerOptions = Parameters<typeof createCommanderTerminalRestorer>[0];

/**
 * Owns the Terminal restore slice. Create: the interrupted-Terminal restorers for the user's Sessions and the Agent
 * Commander's, each behind its fire-and-forget background wrapper. Start: registers the suspension service's reselect
 * hook so a reselected suspended Session restores. Close: the composition root closes the returned `commanderRestores`
 * after `terminalRestores`, in its fixed close order.
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
    const { restore: restoreCommander, supervisor: commanderRestores } =
        createCommanderTerminalRestorer(restorerOptions);
    const restoreCommanderTerminals = createBackgroundTasks(
        logger,
        files,
        git,
        restoreCommander,
    ).restoreInterruptedTerminalsInBackground;
    return {
        commanderRestores,
        restoreCommanderTerminals,
        restoreInterruptedTerminalsInBackground,
        watchSessionInBackground,
    };
}

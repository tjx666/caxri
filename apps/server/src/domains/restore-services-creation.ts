import type { AgentChatService } from './agent-chat';
import { createBackgroundTasks } from './background-tasks';
import type { FileService } from './files';
import type { GitService } from './git';
import type { TerminalRestoreSupervisor, TerminalSuspensionService } from './terminal';
import { createCommanderTerminalRestorer, createInterruptedTerminalRestorer } from './terminal';

type RestorerOptions = Parameters<typeof createCommanderTerminalRestorer>[0];

/**
 * Wires the interrupted-Terminal restore paths (the user's Sessions and the Agent Commander's) to their background
 * wrappers and to the suspension service's reselect hook. Kept out of `create-domain-services.ts` for its line budget.
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

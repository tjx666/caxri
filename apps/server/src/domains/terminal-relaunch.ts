import type { AgentChatService } from './agent-chat';
import type { DomainHandlers } from './domain-services';
import type { MobileTerminalMutationQueue } from './mobile-terminal-mutation-queue';
import { createTerminalRestartHandler } from './terminal-restart';
import type { TerminalSurfaceSwitchOptions } from './terminal-surface-switch';
import { createTerminalSurfaceSwitchHandler } from './terminal-surface-switch';

/**
 * The handlers that replace a Terminal's process in place: `terminal.restart` and `terminal.switchSurface`. A switch
 * runs in the Terminal's mutation queue so a mobile submit cannot land in a PTY that is being handed to a Chat.
 */
export function createRelaunchHandlers({
    agentChat,
    mobileTerminalMutations,
    ...options
}: Omit<TerminalSurfaceSwitchOptions, 'chat'> & {
    agentChat: AgentChatService;
    mobileTerminalMutations: MobileTerminalMutationQueue;
}): Pick<DomainHandlers, 'terminal.restart' | 'terminal.switchSurface'> {
    const switchSurface = createTerminalSurfaceSwitchHandler({ ...options, chat: agentChat });
    return {
        'terminal.restart': createTerminalRestartHandler({
            ...options,
            restartChat: (terminalId, shouldKeepAgentAutonomy) =>
                agentChat.restart(terminalId, shouldKeepAgentAutonomy),
        }),
        'terminal.switchSurface': (parameters) =>
            mobileTerminalMutations.run(parameters.terminalId, () => switchSurface(parameters)),
    };
}

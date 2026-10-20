import {
    interruptAgentChat,
    isAgentChatStopping,
    useAgentChatStopStore,
} from '../agent-chat-commands';

/**
 * Whether a Stop is pending for this turn. The state lives in a store keyed by Chat Terminal and turn, so the Stop
 * button, the status row, and the pane-level Escape all agree, and a failed request frees every one of them at once.
 */
export function useIsAgentChatStopping(terminalId: string, turnId: string | undefined): boolean {
    return useAgentChatStopStore(({ stopping }) =>
        isAgentChatStopping(stopping, terminalId, turnId),
    );
}

/**
 * Interrupts the running turn from Stop or Escape and reports whether that request is still pending.
 */
export function useAgentChatStop({
    activeTurnId,
    terminalId,
}: {
    activeTurnId: string | undefined;
    terminalId: string;
}) {
    const isStopping = useIsAgentChatStopping(terminalId, activeTurnId);
    const stop = (): void => {
        if (!activeTurnId || isStopping) return;
        interruptAgentChat(terminalId, activeTurnId);
    };
    return { isStopping, stop };
}

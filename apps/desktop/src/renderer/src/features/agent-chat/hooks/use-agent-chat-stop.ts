import { useState } from 'react';

import { interruptAgentChat } from '../agent-chat-commands';

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
    /**
     * The turn a Stop was requested for. Keyed by turn so the pending state ends by itself when that turn does, and a
     * later turn starts with a live Stop button.
     */
    const [stoppingTurnId, setStoppingTurnId] = useState<string>();
    const isStopping = activeTurnId !== undefined && stoppingTurnId === activeTurnId;
    const stop = (): void => {
        if (!activeTurnId || isStopping) return;
        setStoppingTurnId(activeTurnId);
        interruptAgentChat(terminalId);
    };
    return { isStopping, stop };
}

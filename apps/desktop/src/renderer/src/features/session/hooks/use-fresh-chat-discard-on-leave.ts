import { useEffect } from 'react';

import { useWorkbenchStore } from '../../../stores/workbench';
import { discardFreshChatOnLeave } from '../fresh-chat-commands';
import { useFreshChatSessionStore } from '../fresh-chat-session';

/**
 * Discards a fresh Chat once the window's selection leaves it. Observed on the store rather than at each selection
 * entry point, because a selection can also arrive from Main (a notification click) without a Renderer command.
 */
export function useFreshChatDiscardOnLeave(): void {
    useEffect(
        () =>
            useWorkbenchStore.subscribe((state, previous) => {
                const left = previous.bootstrap?.selectedSessionId;
                if (!left || left === state.bootstrap?.selectedSessionId) return;
                if (useFreshChatSessionStore.getState().sessionIds.has(left))
                    discardFreshChatOnLeave(left);
            }),
        [],
    );
}

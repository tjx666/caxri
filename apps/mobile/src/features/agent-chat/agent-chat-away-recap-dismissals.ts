import { useSyncExternalStore } from 'react';

import { notifyListeners } from '../../lib/notify-listeners';

/**
 * Per Chat Terminal, the `generatedAt` of the away recap the user closed on this phone. Keyed by generation rather than
 * a flag so the next recap of the same Chat shows again. Module state in memory only, like the recap itself (Server
 * Core keeps it on the live projection) and like Desktop's close: leaving the Session and coming back keeps it closed,
 * a relaunch forgets it.
 */
const dismissed = new Map<string, number>();
const listeners = new Set<(value: undefined) => void>();

export const dismissAgentChatAwayRecap = (terminalId: string, generatedAt: number): void => {
    dismissed.set(terminalId, generatedAt);
    notifyListeners(listeners, undefined);
};

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

/**
 * The `generatedAt` of the recap the user closed on this Chat, so the timeline can leave exactly that one out.
 */
export const useDismissedAgentChatAwayRecap = (
    terminalId: string | undefined,
): number | undefined =>
    useSyncExternalStore(subscribe, () =>
        terminalId === undefined ? undefined : dismissed.get(terminalId),
    );

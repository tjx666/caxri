import { useEffect } from 'react';

import { readLocalStorageJson, writeLocalStorageJson } from '../../../lib/local-storage';
import { createStore } from '../../../lib/store';

const STORAGE_KEY = 'caxri.agentChat.deliveryHint';

/**
 * How many running turns show the `Enter to queue · ⌘Enter to steer` hint before it retires. Send's tooltip keeps both
 * shortcuts after that.
 */
export const DELIVERY_HINT_TURNS = 3;

/**
 * Whether the user still needs the strip's delivery hint, remembered on this device.
 */
export interface AgentChatDeliveryHintState {
    /**
     * Set once the user sent a message while a turn ran (queued or steered it): they know the shortcuts.
     */
    isLearned: boolean;
    /**
     * The running turns that showed the hint, up to {@link DELIVERY_HINT_TURNS}.
     */
    turnIds: readonly string[];
}

export function parseAgentChatDeliveryHint(stored: unknown): AgentChatDeliveryHintState {
    if (typeof stored !== 'object' || stored === null) return { isLearned: false, turnIds: [] };
    const { isLearned, turnIds } = stored as Partial<
        Record<keyof AgentChatDeliveryHintState, unknown>
    >;
    return {
        isLearned: isLearned === true,
        turnIds: Array.isArray(turnIds)
            ? turnIds
                  .filter((id): id is string => typeof id === 'string')
                  .slice(0, DELIVERY_HINT_TURNS)
            : [],
    };
}

/**
 * Whether `turnId` shows the hint: until the user learned the shortcuts, in the first {@link DELIVERY_HINT_TURNS}
 * running turns that needed it, and for the rest of each of those turns.
 */
export function isAgentChatDeliveryHintDue(
    state: AgentChatDeliveryHintState,
    turnId: string,
): boolean {
    if (state.isLearned) return false;
    return state.turnIds.includes(turnId) || state.turnIds.length < DELIVERY_HINT_TURNS;
}

const useDeliveryHintStore = createStore<AgentChatDeliveryHintState>(
    'agent-chat-delivery-hint',
    () => parseAgentChatDeliveryHint(readLocalStorageJson(STORAGE_KEY)),
);

function update(next: AgentChatDeliveryHintState): void {
    useDeliveryHintStore.setState(next);
    writeLocalStorageJson(STORAGE_KEY, next);
}

/**
 * Retires the hint: the user just sent a message into a running turn.
 */
export function learnAgentChatDeliveryHint(): void {
    const state = useDeliveryHintStore.getState();
    if (!state.isLearned) update({ ...state, isLearned: true });
}

/**
 * Whether the strip shows the delivery hint for a draft typed during `turnId`, counting the turn toward the hint's
 * limit the first time it shows there.
 */
export function useIsAgentChatDeliveryHintShown(
    turnId: string | undefined,
    isDrafting: boolean,
): boolean {
    const isDue = useDeliveryHintStore(
        (state) => turnId !== undefined && isAgentChatDeliveryHintDue(state, turnId),
    );
    const isShown = isDrafting && isDue;
    useEffect(() => {
        if (!isShown || turnId === undefined) return;
        const state = useDeliveryHintStore.getState();
        if (!state.turnIds.includes(turnId))
            update({ ...state, turnIds: [...state.turnIds, turnId] });
    }, [isShown, turnId]);
    return isShown;
}

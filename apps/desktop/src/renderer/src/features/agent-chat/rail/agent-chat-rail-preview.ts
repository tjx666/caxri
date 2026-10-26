/**
 * Which message rail tick's preview card is shown, and which one is waiting out the open delay. Each tick's pending
 * open or close is keyed to that tick's mark id, so a timer or a leave left behind by a tick the pointer already passed
 * can never close, or put its own text into, the card of the tick the pointer is on now.
 */
export interface AgentChatRailPreviewState {
    /**
     * The mark whose card is open.
     */
    shownId?: string;
    /**
     * The mark whose card opens when its delay runs out, while no card is open yet.
     */
    pendingId?: string;
}

export type AgentChatRailPreviewEvent =
    /**
     * The pointer entered a tick, or keyboard focus reached one.
     */
    | { type: 'enter'; id: string }
    /**
     * The pointer left a tick, or focus left it.
     */
    | { type: 'leave'; id: string }
    | { type: 'openElapsed'; id: string }
    | { type: 'closeElapsed'; id: string }
    /**
     * Escape, a jump, or the mark leaving the rail: close at once.
     */
    | { type: 'dismiss' };

/**
 * What the hook has to schedule after a step: start the open delay, start the close delay, or cancel whatever delay is
 * running (the only timers there are belong to the previous step).
 */
export type AgentChatRailPreviewEffect = 'cancel' | 'none' | 'scheduleClose' | 'scheduleOpen';

/**
 * One step of the rail preview. A card already open moves to the next tick at once rather than waiting out the open
 * delay again, so sweeping the rail reads tick after tick instead of closing and reopening between them.
 */
export function agentChatRailPreviewStep(
    state: AgentChatRailPreviewState,
    event: AgentChatRailPreviewEvent,
): { state: AgentChatRailPreviewState; effect: AgentChatRailPreviewEffect } {
    switch (event.type) {
        case 'enter': {
            if (state.shownId !== undefined)
                return { state: { shownId: event.id }, effect: 'cancel' };
            return { state: { pendingId: event.id }, effect: 'scheduleOpen' };
        }
        case 'leave': {
            if (event.id === state.pendingId) return { state: {}, effect: 'cancel' };
            if (event.id === state.shownId) return { state, effect: 'scheduleClose' };
            return { state, effect: 'none' };
        }
        case 'openElapsed': {
            if (event.id !== state.pendingId) return { state, effect: 'none' };
            return { state: { shownId: event.id }, effect: 'none' };
        }
        case 'closeElapsed': {
            if (event.id !== state.shownId) return { state, effect: 'none' };
            return { state: {}, effect: 'none' };
        }
        case 'dismiss': {
            return { state: {}, effect: 'cancel' };
        }
    }
}

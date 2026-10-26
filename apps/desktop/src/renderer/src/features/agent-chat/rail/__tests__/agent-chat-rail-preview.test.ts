import { describe, expect, it } from 'vitest';

import type {
    AgentChatRailPreviewEvent,
    AgentChatRailPreviewState,
} from '../agent-chat-rail-preview';
import { agentChatRailPreviewStep } from '../agent-chat-rail-preview';

/**
 * Runs `events` from a closed card, returning the state after each step and the effect it asked for.
 */
function run(events: AgentChatRailPreviewEvent[]) {
    let state: AgentChatRailPreviewState = {};
    return events.map((event) => {
        const step = agentChatRailPreviewStep(state, event);
        state = step.state;
        return step;
    });
}

describe('agentChatRailPreviewStep', () => {
    it('opens a tick after its delay and closes it after the pointer leaves', () => {
        const steps = run([
            { type: 'enter', id: 'a' },
            { type: 'openElapsed', id: 'a' },
            { type: 'leave', id: 'a' },
            { type: 'closeElapsed', id: 'a' },
        ]);
        expect(steps.map(({ effect }) => effect)).toEqual([
            'scheduleOpen',
            'none',
            'scheduleClose',
            'none',
        ]);
        expect(steps.map(({ state }) => state)).toEqual([
            { pendingId: 'a' },
            { shownId: 'a' },
            { shownId: 'a' },
            {},
        ]);
    });

    it('moves an open card to the next tick at once and cancels the close the previous tick started', () => {
        const steps = run([
            { type: 'enter', id: 'a' },
            { type: 'openElapsed', id: 'a' },
            { type: 'leave', id: 'a' },
            { type: 'enter', id: 'b' },
            // The previous tick's close, had it not been cancelled, still cannot close the next one.
            { type: 'closeElapsed', id: 'a' },
        ]);
        expect(steps.at(3)).toEqual({ state: { shownId: 'b' }, effect: 'cancel' });
        expect(steps.at(4)?.state).toEqual({ shownId: 'b' });
    });

    it('never opens the card for a tick the pointer passed before its delay ran out', () => {
        const steps = run([
            { type: 'enter', id: 'a' },
            { type: 'leave', id: 'a' },
            { type: 'enter', id: 'b' },
            { type: 'openElapsed', id: 'a' },
        ]);
        expect(steps.at(1)).toEqual({ state: {}, effect: 'cancel' });
        expect(steps.at(3)?.state).toEqual({ pendingId: 'b' });
    });

    it('ignores a leave from a tick other than the shown one', () => {
        const steps = run([
            { type: 'enter', id: 'a' },
            { type: 'openElapsed', id: 'a' },
            { type: 'enter', id: 'b' },
            { type: 'leave', id: 'a' },
        ]);
        expect(steps.at(3)).toEqual({ state: { shownId: 'b' }, effect: 'none' });
    });

    it('closes at once on dismiss', () => {
        const steps = run([
            { type: 'enter', id: 'a' },
            { type: 'openElapsed', id: 'a' },
            { type: 'dismiss' },
        ]);
        expect(steps.at(2)).toEqual({ state: {}, effect: 'cancel' });
    });
});

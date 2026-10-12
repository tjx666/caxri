import { describe, expect, it, vi } from 'vitest';

import type { ToastActionHandlers, ToastActionId } from './toast-actions';
import {
    configureToastActions,
    runToastAction,
    toastActionLabelKeys,
    unknownToastActionReason,
} from './toast-actions';

const ACTION_IDS = Object.keys(toastActionLabelKeys) as ToastActionId[];

/**
 * Every follow-up wired to a spy that records nothing but the call, so a test can install the whole table and then
 * override only the one identity it is about.
 */
function installHandlers(
    overrides: Partial<ToastActionHandlers> = {},
): Record<ToastActionId, ReturnType<typeof vi.fn>> {
    const runs = {} as Record<ToastActionId, ReturnType<typeof vi.fn>>;
    const handlers = {} as ToastActionHandlers;
    for (const id of ACTION_IDS) {
        runs[id] = vi.fn();
        Object.assign(handlers, { [id]: { run: runs[id] } });
    }
    Object.assign(handlers, overrides);
    configureToastActions(handlers);
    return runs;
}

describe('toast action registry', () => {
    it('names every follow-up it can carry', () => {
        // The catalog is what the notification center renders from: an id with no label would put a nameless button in
        // the history days after the toast that offered it expired.
        for (const id of ACTION_IDS) expect(toastActionLabelKeys[id]).toBeTruthy();
        expect(ACTION_IDS.length).toBeGreaterThan(0);
    });

    it('refuses a follow-up before the handlers are installed', () => {
        configureToastActions(undefined as unknown as ToastActionHandlers);

        // A notification can be raised while the module graph that owns the behavior is still evaluating. Failing
        // closed here is what keeps a button from looking live and then doing nothing.
        expect(runToastAction({ id: 'settings.open' })).toBe(unknownToastActionReason());
    });

    it('runs the installed follow-up with the data the notification recorded', () => {
        const runs = installHandlers();

        expect(
            runToastAction({ id: 'terminal.restart', params: { terminalId: 't-1' } }),
        ).toBeUndefined();

        expect(runs['terminal.restart']).toHaveBeenCalledWith({ terminalId: 't-1' });
    });

    it('answers with the reason instead of running a follow-up that no longer applies', () => {
        const run = vi.fn();
        const runs = installHandlers({
            'session.unarchive': { unavailable: () => 'That Session no longer exists.', run },
        });

        expect(runToastAction({ id: 'session.unarchive', params: { sessionId: 'gone' } })).toBe(
            'That Session no longer exists.',
        );

        // The point of asking at click time: the answer replaces the click, it does not merely annotate it.
        expect(run).not.toHaveBeenCalled();
        expect(runs['session.unarchive']).not.toHaveBeenCalled();
    });
});

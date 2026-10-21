import { describe, expect, it, vi } from 'vitest';

import { createPresenceEffects } from '../effects';
import { WindowPresence } from '../window-presence';

const report = (windowKey: string, viewingSessionId: string, isFocused: boolean) => ({
    focused: isFocused,
    viewingSessionId,
    visible: true,
    windowKey,
});

function setup() {
    let clock = 0;
    const presence = new WindowPresence(() => ++clock);
    const watchSessionInBackground = vi.fn();
    const effects = createPresenceEffects({
        coordinator: { probeSessionPrimaryAgent: vi.fn() },
        database: { windowOpenSessions: { all: () => ({}) } } as never,
        presence,
        projectStatus: { setPolledSessions: vi.fn() },
        restoreInterruptedTerminalsInBackground: vi.fn(),
        sendFullStateChange: vi.fn(),
        terminalSuspension: { observeVisibility: vi.fn() },
        watchSessionInBackground,
    });
    return { effects, presence, watchSessionInBackground };
}

describe('createPresenceEffects watcher', () => {
    it('rewatches when focus flips between windows showing different Sessions', () => {
        const { presence, watchSessionInBackground } = setup();
        presence.report('c', report('w1', 'a', true));
        presence.report('c', report('w2', 'b', false));
        expect(watchSessionInBackground).toHaveBeenLastCalledWith('a');

        presence.report('c', report('w2', 'b', true));

        expect(watchSessionInBackground).toHaveBeenLastCalledWith('b');
    });

    it('does not rewatch when both windows show the same Session', () => {
        const { presence, watchSessionInBackground } = setup();
        presence.report('c', report('w1', 'a', true));
        presence.report('c', report('w2', 'a', false));
        watchSessionInBackground.mockClear();

        presence.report('c', report('w2', 'a', true));

        expect(watchSessionInBackground).not.toHaveBeenCalled();
    });

    it('stops following presence after unsubscribe', () => {
        const { effects, presence, watchSessionInBackground } = setup();
        effects.unsubscribe();

        presence.report('c', report('w1', 'a', true));

        expect(watchSessionInBackground).not.toHaveBeenCalled();
    });
});

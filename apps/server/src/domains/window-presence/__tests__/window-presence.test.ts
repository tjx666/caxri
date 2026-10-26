import { describe, expect, it, vi } from 'vitest';

import { PRESENCE_SEED_GRACE_MS, WindowPresence } from '../window-presence';

function fixture() {
    let clock = 0;
    const presence = new WindowPresence(() => ++clock);
    const onVisible = vi.fn();
    const onCurrent = vi.fn();
    presence.onVisibleChange(onVisible);
    presence.onCurrentChange(onCurrent);
    return { onCurrent, onVisible, presence };
}

const report = (
    windowKey: string,
    viewingSessionId: string | null,
    state: { focused?: boolean; visible?: boolean } = {},
) => ({
    focused: state.focused ?? false,
    viewingSessionId,
    visible: state.visible ?? true,
    windowKey,
});

describe('WindowPresence', () => {
    it('starts with nothing visible and no current Session', () => {
        const { presence } = fixture();
        expect(presence.visibleSessionIds().size).toBe(0);
        expect(presence.currentSessionId()).toBeUndefined();
    });

    it('unions the Sessions of visible windows and ignores hidden ones', () => {
        const { presence } = fixture();
        presence.report('c1', report('w1', 'a'));
        presence.report('c1', report('w2', 'b'));
        presence.report('c1', report('w3', 'c', { visible: false }));
        expect([...presence.visibleSessionIds()].toSorted((x, y) => x.localeCompare(y))).toEqual([
            'a',
            'b',
        ]);
    });

    it('makes the focused window current, and falls back to the most recently focused one', () => {
        const { presence } = fixture();
        presence.report('c1', report('w1', 'a', { focused: true }));
        presence.report('c1', report('w2', 'b'));
        expect(presence.currentSessionId()).toBe('a');

        presence.report('c1', report('w1', 'a'));
        presence.report('c1', report('w2', 'b', { focused: true }));
        expect(presence.currentSessionId()).toBe('b');

        presence.report('c1', report('w2', 'b'));
        expect(presence.currentSessionId()).toBe('b');
    });

    it('notifies only on a real change', () => {
        const { onCurrent, onVisible, presence } = fixture();
        presence.report('c1', report('w1', 'a', { focused: true }));
        expect(onVisible).toHaveBeenCalledTimes(1);
        expect(onCurrent).toHaveBeenCalledTimes(1);

        presence.report('c1', report('w2', 'a'));
        presence.report('c1', report('w1', 'a', { focused: true }));
        expect(onVisible).toHaveBeenCalledTimes(1);
        expect(onCurrent).toHaveBeenCalledTimes(1);
    });

    it('applies noteViewing to a window that already reported, across connections, and never invents one', () => {
        const { presence } = fixture();
        presence.noteViewing('w1', 'a');
        expect(presence.visibleSessionIds().size).toBe(0);

        presence.report('c1', report('w1', 'a'));
        presence.noteViewing('w1', 'b');
        expect([...presence.visibleSessionIds()]).toEqual(['b']);
    });

    it('forgets a closed window and every window of a dropped connection', () => {
        const { presence } = fixture();
        presence.report('c1', report('w1', 'a'));
        presence.report('c1', report('w2', 'b'));
        presence.report('c2', report('w3', 'c'));

        presence.close('c1', 'w1');
        expect([...presence.visibleSessionIds()].toSorted((x, y) => x.localeCompare(y))).toEqual([
            'b',
            'c',
        ]);

        presence.dropConnection('c1');
        expect([...presence.visibleSessionIds()]).toEqual(['c']);
        presence.dropConnection('missing');
        expect([...presence.visibleSessionIds()]).toEqual(['c']);
    });

    it('replaces every row of a connection with one seed and notifies once', () => {
        const { onCurrent, onVisible, presence } = fixture();
        presence.report('c1', report('w1', 'a'));
        presence.report('c2', report('w9', 'z'));
        onVisible.mockClear();
        onCurrent.mockClear();

        presence.seed('c1', [
            { ...report('w1', 'b', { focused: true }), focusedAt: 5 },
            { ...report('w2', 'c'), focusedAt: 9 },
        ]);

        expect([...presence.visibleSessionIds()].toSorted((x, y) => x.localeCompare(y))).toEqual([
            'b',
            'c',
            'z',
        ]);
        expect(presence.currentSessionId()).toBe('b');
        expect(onVisible).toHaveBeenCalledTimes(1);
        expect(onCurrent).toHaveBeenCalledTimes(1);
    });

    it('keeps the focus history of a seed, so the most recently focused window stays current', () => {
        const { presence } = fixture();
        presence.seed('c1', [
            { ...report('w1', 'a'), focusedAt: 10 },
            { ...report('w2', 'b'), focusedAt: 20 },
        ]);
        expect(presence.currentSessionId()).toBe('b');
    });

    it('treats an empty seed as a confirmed absence of windows', () => {
        let now = 0;
        const presence = new WindowPresence(() => now);
        expect(presence.isSettled()).toBe(false);
        presence.seed('c1', []);
        expect(presence.isSettled()).toBe(true);
        expect(presence.visibleSessionIds().size).toBe(0);
        now = 1;
        expect(presence.isSettled()).toBe(true);
    });

    it('is unsettled until the first report or the grace period, and again after the last connection drops', () => {
        let now = 1000;
        const presence = new WindowPresence(() => now);
        expect(presence.isSettled()).toBe(false);
        now += PRESENCE_SEED_GRACE_MS;
        expect(presence.isSettled()).toBe(true);

        presence.report('c1', report('w1', 'a'));
        expect(presence.isSettled()).toBe(true);
        presence.dropConnection('c1');
        expect(presence.isSettled()).toBe(false);
        presence.report('c2', report('w1', 'a'));
        expect(presence.isSettled()).toBe(true);
        presence.close('c2', 'w1');
        // A window that closed is a confirmed absence, not a gap to wait out.
        expect(presence.isSettled()).toBe(true);
    });

    it('reports leaving the watched Session on a switch, a focus loss, and a dropped connection', () => {
        const { presence } = fixture();
        const left: string[] = [];
        presence.onWatchedLeave((sessionId) => left.push(sessionId));

        presence.report('c1', report('w1', 'a', { focused: true }));
        expect(presence.watchedSessionId()).toBe('a');
        presence.noteViewing('w1', 'b');
        presence.report('c1', report('w1', 'b'));
        expect(presence.watchedSessionId()).toBeUndefined();
        presence.report('c1', report('w1', 'b', { focused: true }));
        presence.dropConnection('c1');

        expect(left).toEqual(['a', 'b', 'b']);
    });

    it('never treats a hidden or unfocused window as watched', () => {
        const { presence } = fixture();
        const onLeave = vi.fn();
        presence.onWatchedLeave(onLeave);

        presence.report('c1', report('w1', 'a', { focused: true, visible: false }));
        presence.report('c1', report('w2', 'b'));
        presence.dropConnection('c1');

        expect(presence.watchedSessionId()).toBeUndefined();
        expect(onLeave).not.toHaveBeenCalled();
    });
});

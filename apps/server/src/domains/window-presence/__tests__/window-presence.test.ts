import { describe, expect, it, vi } from 'vitest';

import { WindowPresence } from '../window-presence';

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
});

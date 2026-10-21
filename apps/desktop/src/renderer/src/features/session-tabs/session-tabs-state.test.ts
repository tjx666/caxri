import { describe, expect, it } from 'vitest';

import {
    activeAfterEdit,
    appendOpenSession,
    isSessionTabStripVisible,
    moveOpenSession,
    openTabTargetId,
    sessionIdsToClose,
    sessionTabShortcutKey,
    shiftOpenSession,
    shouldTearOffSessionTab,
    withoutOpenSessions,
} from './session-tabs-state';

describe('strip visibility', () => {
    it('hides below two Open Sessions and shows from two on', () => {
        expect(isSessionTabStripVisible([])).toBe(false);
        expect(isSessionTabStripVisible(['a'])).toBe(false);
        expect(isSessionTabStripVisible(['a', 'b'])).toBe(true);
    });
});

describe('appendOpenSession', () => {
    it('appends a new entry and leaves an open one where it is', () => {
        expect(appendOpenSession(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
        expect(appendOpenSession(['a', 'b'], 'a')).toEqual(['a', 'b']);
    });
});

describe('moveOpenSession', () => {
    it('lands before the entry at the index measured without the dragged tab', () => {
        expect(moveOpenSession(['a', 'b', 'c', 'd'], 'd', 1)).toEqual(['a', 'd', 'b', 'c']);
        expect(moveOpenSession(['a', 'b', 'c', 'd'], 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
    });

    it('moves to the end when the drop is past every tab', () => {
        expect(moveOpenSession(['a', 'b', 'c'], 'a', undefined)).toEqual(['b', 'c', 'a']);
    });

    it('keeps the order for a drop onto its own position and ignores unknown entries', () => {
        expect(moveOpenSession(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'b', 'c']);
        expect(moveOpenSession(['a', 'b'], 'x', 0)).toEqual(['a', 'b']);
    });
});

describe('shiftOpenSession', () => {
    it('moves one step and stays put at either end', () => {
        expect(shiftOpenSession(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
        expect(shiftOpenSession(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
        expect(shiftOpenSession(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
        expect(shiftOpenSession(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
    });
});

describe('sessionIdsToClose', () => {
    const ids = ['a', 'b', 'c', 'd'];

    it('closes one, the others, or everything to the right', () => {
        expect(sessionIdsToClose(ids, 'b', 'one')).toEqual(['b']);
        expect(sessionIdsToClose(ids, 'b', 'others')).toEqual(['a', 'c', 'd']);
        expect(sessionIdsToClose(ids, 'b', 'right')).toEqual(['c', 'd']);
    });

    it('never closes the last remaining entry or an unknown one', () => {
        expect(sessionIdsToClose(['a'], 'a', 'one')).toEqual([]);
        expect(sessionIdsToClose(ids, 'x', 'one')).toEqual([]);
        expect(sessionIdsToClose(ids, 'd', 'right')).toEqual([]);
    });

    it('removes exactly the closed entries', () => {
        expect(withoutOpenSessions(ids, ['b', 'd'])).toEqual(['a', 'c']);
    });
});

describe('activeAfterEdit', () => {
    const ids = ['a', 'b', 'c', 'd'];

    it('keeps the active entry across a reorder or another entry closing', () => {
        expect(activeAfterEdit(ids, 'b', ['d', 'c', 'b', 'a'])).toBe('b');
        expect(activeAfterEdit(ids, 'b', ['a', 'b', 'd'])).toBe('b');
    });

    it('moves to the next neighbor when the active entry closes, else the previous one', () => {
        expect(activeAfterEdit(ids, 'b', ['a', 'c', 'd'])).toBe('c');
        expect(activeAfterEdit(ids, 'd', ['a', 'b', 'c'])).toBe('c');
    });

    it('skips neighbors that closed with it', () => {
        expect(activeAfterEdit(ids, 'b', ['a', 'd'])).toBe('d');
        expect(activeAfterEdit(ids, 'c', ['a', 'b'])).toBe('b');
    });

    it('falls back to the first entry, or none for an empty strip', () => {
        expect(activeAfterEdit(ids, undefined, ['c', 'd'])).toBe('c');
        expect(activeAfterEdit(ids, 'a', [])).toBeUndefined();
    });
});

describe('openTabTargetId', () => {
    const ids = ['a', 'b', 'c'];

    it('maps positions one to eight literally', () => {
        expect(openTabTargetId(ids, 1)).toBe('a');
        expect(openTabTargetId(ids, 3)).toBe('c');
    });

    it('maps nine to the last entry whatever the strip length', () => {
        expect(openTabTargetId(ids, 9)).toBe('c');
        expect(
            openTabTargetId(
                Array.from({ length: 20 }, (_, index) => `s${index}`),
                9,
            ),
        ).toBe('s19');
    });

    it('selects nothing past the end or outside one to nine', () => {
        expect(openTabTargetId(ids, 4)).toBeUndefined();
        expect(openTabTargetId(ids, 0)).toBeUndefined();
        expect(openTabTargetId(ids, 10)).toBeUndefined();
        expect(openTabTargetId([], 9)).toBeUndefined();
    });
});

describe('shouldTearOffSessionTab', () => {
    it('tears off only a drag that ended outside every drop target', () => {
        expect(shouldTearOffSessionTab({ dropEffect: 'none', dropped: false, tabCount: 3 })).toBe(
            true,
        );
        expect(shouldTearOffSessionTab({ dropEffect: 'move', dropped: false, tabCount: 3 })).toBe(
            false,
        );
        expect(shouldTearOffSessionTab({ dropEffect: 'copy', dropped: false, tabCount: 3 })).toBe(
            false,
        );
    });

    it('never tears off a drag whose drop the strip handled, even when dropEffect reads none', () => {
        expect(shouldTearOffSessionTab({ dropEffect: 'none', dropped: true, tabCount: 3 })).toBe(
            false,
        );
    });

    it('never moves the last Open Session out of a window', () => {
        expect(shouldTearOffSessionTab({ dropEffect: 'none', dropped: false, tabCount: 1 })).toBe(
            false,
        );
    });
});

describe('sessionTabShortcutKey', () => {
    it('labels the first eight tabs by position', () => {
        expect(sessionTabShortcutKey(0, 3)).toBe('Meta+1');
        expect(sessionTabShortcutKey(7, 20)).toBe('Meta+8');
    });

    it('labels only the last tab with Meta+9, since Cmd+9 means last', () => {
        expect(sessionTabShortcutKey(11, 12)).toBe('Meta+9');
        expect(sessionTabShortcutKey(8, 9)).toBe('Meta+9');
        expect(sessionTabShortcutKey(8, 12)).toBeUndefined();
    });
});

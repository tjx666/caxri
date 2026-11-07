import type { SessionMenuLayout } from '@caxri/protocol';
import { defaultSessionMenuLayout, sessionMenuItemIds } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    canInsertSessionMenuSeparator,
    insertSessionMenuSeparator,
    moveSessionMenuEntry,
    moveSessionMenuEntryBy,
    removeSessionMenuSeparator,
    toggleSessionMenuItemHidden,
    toStoredSessionMenuLayout,
} from '../session-menu-layout-editing';

const flat: SessionMenuLayout = { order: [...sessionMenuItemIds], hidden: [] };

describe('moveSessionMenuEntry', () => {
    it('moves an entry up before the target index', () => {
        const moved = moveSessionMenuEntry(flat, 2, 0);
        expect(moved.order.slice(0, 3)).toEqual(['pin', 'markAsDone', 'archive']);
    });

    it('moves an entry down so it lands before the target index', () => {
        const moved = moveSessionMenuEntry(flat, 0, 3);
        expect(moved.order.slice(0, 3)).toEqual(['archive', 'pin', 'markAsDone']);
    });

    it('treats a drop right below the dragged row as a no-op', () => {
        expect(moveSessionMenuEntry(flat, 4, 5)).toBe(flat);
        expect(moveSessionMenuEntry(flat, 4, 4)).toBe(flat);
    });

    it('moves an entry to the end', () => {
        const moved = moveSessionMenuEntry(flat, 0, flat.order.length);
        expect(moved.order.at(-1)).toBe('markAsDone');
    });
});

describe('moveSessionMenuEntryBy', () => {
    it('moves one row up or down and stops at the ends', () => {
        expect(moveSessionMenuEntryBy(flat, 1, -1).order.slice(0, 2)).toEqual([
            'archive',
            'markAsDone',
        ]);
        expect(moveSessionMenuEntryBy(flat, 0, 1).order.slice(0, 2)).toEqual([
            'archive',
            'markAsDone',
        ]);
        expect(moveSessionMenuEntryBy(flat, 0, -1)).toBe(flat);
        expect(moveSessionMenuEntryBy(flat, flat.order.length - 1, 1)).toBe(flat);
    });
});

describe('toggleSessionMenuItemHidden', () => {
    it('hides and shows an item without moving it', () => {
        const hidden = toggleSessionMenuItemHidden(flat, 'handOverToBot');
        expect(hidden.hidden).toEqual(['handOverToBot']);
        expect(hidden.order).toEqual(flat.order);
        expect(toggleSessionMenuItemHidden(hidden, 'handOverToBot').hidden).toEqual([]);
    });
});

describe('separators', () => {
    it('inserts a separator below an item and removes it again', () => {
        const withSeparator = insertSessionMenuSeparator(flat, 1);
        expect(withSeparator.order.slice(0, 4)).toEqual([
            'markAsDone',
            'archive',
            'separator',
            'pin',
        ]);
        expect(removeSessionMenuSeparator(withSeparator, 2)).toEqual(flat);
    });

    it('refuses a separator after the last entry or next to another separator', () => {
        expect(canInsertSessionMenuSeparator(flat, flat.order.length - 1)).toBe(false);
        const withSeparator = insertSessionMenuSeparator(flat, 1);
        expect(canInsertSessionMenuSeparator(withSeparator, 1)).toBe(false);
        expect(canInsertSessionMenuSeparator(withSeparator, 2)).toBe(false);
    });
});

describe('toStoredSessionMenuLayout', () => {
    it('stores null once an edit returns to the built-in layout', () => {
        expect(toStoredSessionMenuLayout(structuredClone(defaultSessionMenuLayout))).toBeNull();
    });

    it('stores a customized layout', () => {
        expect(toStoredSessionMenuLayout(flat)).toEqual(flat);
    });
});

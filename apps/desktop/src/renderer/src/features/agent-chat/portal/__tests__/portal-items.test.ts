import { describe, expect, it } from 'vitest';

import {
    closePortalItem,
    EMPTY_PORTAL_ITEMS,
    openPortalItem,
    retainPortalItems,
    selectPortalItem,
} from '../portal-items';

const open = (...paths: string[]) =>
    paths.reduce((items, path) => openPortalItem(items, path), EMPTY_PORTAL_ITEMS);

describe('openPortalItem', () => {
    it('appends a new item and shows it', () => {
        expect(open('a', 'b')).toEqual({ paths: ['a', 'b'], activePath: 'b' });
    });

    it('selects an open item instead of stacking a duplicate', () => {
        expect(openPortalItem(open('a', 'b'), 'a')).toEqual({ paths: ['a', 'b'], activePath: 'a' });
    });
});

describe('selectPortalItem', () => {
    it('ignores a path the Portal does not hold', () => {
        const items = open('a');
        expect(selectPortalItem(items, 'z')).toBe(items);
    });
});

describe('closePortalItem', () => {
    it('shows the right neighbor after closing the item on screen', () => {
        const items = selectPortalItem(open('a', 'b', 'c'), 'b');
        expect(closePortalItem(items, 'b')).toEqual({ paths: ['a', 'c'], activePath: 'c' });
    });

    it('falls back to the left neighbor when the last item closes', () => {
        expect(closePortalItem(open('a', 'b'), 'b')).toEqual({ paths: ['a'], activePath: 'a' });
    });

    it('keeps the item on screen when a background item closes', () => {
        expect(closePortalItem(open('a', 'b'), 'a')).toEqual({ paths: ['b'], activePath: 'b' });
        expect(closePortalItem(open('a', 'b', 'c'), 'a')).toEqual({
            paths: ['b', 'c'],
            activePath: 'c',
        });
    });

    it('closes the Portal with its last item', () => {
        expect(closePortalItem(open('a'), 'a')).toBe(EMPTY_PORTAL_ITEMS);
    });
});

describe('retainPortalItems', () => {
    it('returns the same items when every one is live', () => {
        const items = open('a', 'b');
        expect(retainPortalItems(items, () => true)).toBe(items);
    });

    it('drops dead items and moves the selection to the first survivor', () => {
        expect(retainPortalItems(open('a', 'b', 'c'), (path) => path !== 'c')).toEqual({
            paths: ['a', 'b'],
            activePath: 'a',
        });
    });

    it('closes the Portal when nothing survives', () => {
        expect(retainPortalItems(open('a'), () => false)).toBe(EMPTY_PORTAL_ITEMS);
    });
});

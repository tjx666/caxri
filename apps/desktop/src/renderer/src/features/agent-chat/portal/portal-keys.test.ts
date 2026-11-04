import { describe, expect, it } from 'vitest';

import { nextPortalTabPath, portalTabId, shouldFocusPortalOnOpen } from './portal-keys';

describe('nextPortalTabPath', () => {
    const paths = ['a', 'b', 'c'];

    it('moves with the arrows and wraps at the ends', () => {
        expect(nextPortalTabPath(paths, 'a', 'ArrowRight')).toBe('b');
        expect(nextPortalTabPath(paths, 'c', 'ArrowRight')).toBe('a');
        expect(nextPortalTabPath(paths, 'a', 'ArrowLeft')).toBe('c');
        expect(nextPortalTabPath(paths, 'b', 'ArrowLeft')).toBe('a');
    });

    it('jumps to the first and last tab', () => {
        expect(nextPortalTabPath(paths, 'b', 'Home')).toBe('a');
        expect(nextPortalTabPath(paths, 'b', 'End')).toBe('c');
    });

    it('ignores other keys, a lone item, and an unknown active path', () => {
        expect(nextPortalTabPath(paths, 'a', 'Enter')).toBeUndefined();
        expect(nextPortalTabPath(['a'], 'a', 'ArrowRight')).toBeUndefined();
        expect(nextPortalTabPath(paths, 'x', 'ArrowRight')).toBeUndefined();
    });
});

describe('shouldFocusPortalOnOpen', () => {
    it('moves focus only for a keyboard activation outside text fields', () => {
        const base = { isEditable: false, isFocusVisible: true, isInsidePortal: false };
        expect(shouldFocusPortalOnOpen(base)).toBe(true);
        expect(shouldFocusPortalOnOpen({ ...base, isFocusVisible: false })).toBe(false);
        expect(shouldFocusPortalOnOpen({ ...base, isEditable: true })).toBe(false);
        expect(shouldFocusPortalOnOpen({ ...base, isInsidePortal: true })).toBe(false);
    });
});

describe('portalTabId', () => {
    it('numbers tabs under a base id', () => {
        expect(portalTabId(':r1:', 2)).toBe(':r1:-tab-2');
    });
});

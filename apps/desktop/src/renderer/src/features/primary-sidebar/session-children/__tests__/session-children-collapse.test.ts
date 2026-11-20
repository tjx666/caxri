import { describe, expect, it } from 'vitest';

import {
    parseSessionChildrenCollapse,
    sessionChildrenExpanded,
    setSessionChildrenCollapsed,
    toggleSessionChildrenCollapsed,
    useSessionChildrenCollapseStore,
} from '../session-children-collapse';

describe('parseSessionChildrenCollapse', () => {
    it('keeps only collapsed hosts and drops anything else', () => {
        expect(parseSessionChildrenCollapse({ a: true, b: false, c: 'yes' })).toEqual({ a: true });
        expect(parseSessionChildrenCollapse(undefined)).toEqual({});
        expect(parseSessionChildrenCollapse(['a'])).toEqual({});
    });
});

describe('sessionChildrenExpanded', () => {
    it('has no answer for a row without children, and is open unless folded', () => {
        expect(sessionChildrenExpanded('a', false, { a: true })).toBeUndefined();
        expect(sessionChildrenExpanded('a', true, {})).toBe(true);
        expect(sessionChildrenExpanded('a', true, { a: true })).toBe(false);
    });
});

describe('session children collapse store', () => {
    it('folds and unfolds one host without touching another', () => {
        setSessionChildrenCollapsed('host-a', true);
        setSessionChildrenCollapsed('host-b', true);
        toggleSessionChildrenCollapsed('host-a');
        expect(useSessionChildrenCollapseStore.getState().collapsed).toEqual({ 'host-b': true });
        toggleSessionChildrenCollapsed('host-b');
        expect(useSessionChildrenCollapseStore.getState().collapsed).toEqual({});
    });
});

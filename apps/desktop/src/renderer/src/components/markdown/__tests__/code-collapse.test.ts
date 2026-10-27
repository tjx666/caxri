import { describe, expect, it } from 'vitest';

import { countCodeLines, isCodeCollapsible } from '../code-collapse';

describe('countCodeLines', () => {
    it('counts an empty block as no lines', () => {
        expect(countCodeLines('')).toBe(0);
    });

    it('counts lines without treating a trailing newline as another line', () => {
        expect(countCodeLines('a')).toBe(1);
        expect(countCodeLines('a\nb')).toBe(2);
        expect(countCodeLines('a\nb\n')).toBe(2);
        expect(countCodeLines('a\n\nb')).toBe(3);
    });
});

describe('isCodeCollapsible', () => {
    it('keeps short blocks open and folds blocks that hide several lines', () => {
        expect(isCodeCollapsible(15)).toBe(false);
        expect(isCodeCollapsible(20)).toBe(false);
        expect(isCodeCollapsible(21)).toBe(true);
        expect(isCodeCollapsible(33)).toBe(true);
    });
});

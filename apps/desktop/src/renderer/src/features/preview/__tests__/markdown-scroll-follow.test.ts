import { describe, expect, it } from 'vitest';

import { previewScrollTop } from '../markdown-scroll-follow';

const anchors = [
    { line: 0, top: 0 },
    { line: 4, top: 100 },
    { line: 10, top: 400 },
];

describe('previewScrollTop', () => {
    it('stays at the top for a document the engine annotated with nothing', () => {
        expect(previewScrollTop([], 12)).toBe(0);
    });

    it('lands exactly on a block that starts at the requested line', () => {
        expect(previewScrollTop(anchors, 4)).toBe(100);
    });

    it('interpolates a line inside a block so a long paragraph tracks smoothly', () => {
        expect(previewScrollTop(anchors, 7)).toBe(250);
    });

    it('holds the first block for a line above it', () => {
        expect(previewScrollTop([{ line: 3, top: 60 }], 1)).toBe(60);
    });

    it('holds the last block for a line past the end of the document', () => {
        expect(previewScrollTop(anchors, 99)).toBe(400);
    });

    it('does not divide by zero when two blocks report the same line', () => {
        expect(
            previewScrollTop(
                [
                    { line: 0, top: 0 },
                    { line: 5, top: 80 },
                    { line: 5, top: 120 },
                ],
                5,
            ),
        ).toBe(120);
    });
});

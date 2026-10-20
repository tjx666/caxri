import { describe, expect, it } from 'vitest';

import { isScrolledToBottom } from '../agent-chat-task-output';

const position = (offset: number, content: number, viewport = 320) => ({
    contentOffset: { x: 0, y: offset },
    contentSize: { height: content, width: 300 },
    layoutMeasurement: { height: viewport, width: 300 },
});

describe('isScrolledToBottom', () => {
    it('treats the end of the output and one line short of it as the bottom', () => {
        expect(isScrolledToBottom(position(680, 1000))).toBe(true);
        expect(isScrolledToBottom(position(662, 1000))).toBe(true);
    });

    it('treats a reader scrolled back through earlier output as away from the bottom', () => {
        expect(isScrolledToBottom(position(600, 1000))).toBe(false);
        expect(isScrolledToBottom(position(0, 1000))).toBe(false);
    });

    it('treats output shorter than the box as at the bottom', () => {
        expect(isScrolledToBottom(position(0, 120))).toBe(true);
    });
});

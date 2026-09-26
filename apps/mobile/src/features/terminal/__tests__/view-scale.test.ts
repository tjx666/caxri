import { describe, expect, it } from 'vitest';

import { isTerminalViewAtBottom, terminalViewScale } from '../view-scale';

describe('mobile Terminal view scale', () => {
    it('keeps a readable default when many Desktop rows exceed the phone height', () => {
        expect(terminalViewScale({ heightFit: 0.24, widthFit: 0.78, zoom: 1 })).toBe(0.6);
    });

    it('allows pinch zoom to show the complete Desktop grid', () => {
        expect(terminalViewScale({ heightFit: 0.24, widthFit: 0.78, zoom: 0.2 })).toBe(0.24);
    });
});

describe('mobile Terminal scroll follow', () => {
    const bottom = { clientHeight: 400, scrollHeight: 900, scrollTop: 500 };
    const scrolledUp = { ...bottom, scrollTop: 300 };

    it('follows output only when both the grid and outer viewport are at the bottom', () => {
        expect(isTerminalViewAtBottom({ baseY: 50, viewportY: 50 }, bottom)).toBe(true);
        expect(isTerminalViewAtBottom({ baseY: 50, viewportY: 50 }, scrolledUp)).toBe(false);
        expect(isTerminalViewAtBottom({ baseY: 50, viewportY: 49 }, bottom)).toBe(false);
    });
});

import { MOBILE_TERMINAL_WHEEL_MAX_LINES } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    isTerminalViewAtBottom,
    leasedTerminalScale,
    shouldForwardTerminalScroll,
    TERMINAL_WHEEL_MAX_LINES,
    terminalPhoneGrid,
    terminalViewScale,
} from '../view-scale';

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

describe('mobile Terminal leased grid', () => {
    const phone = { cellHeight: 16.8, cellWidth: 8.4, height: 700, width: 400 };

    it('keeps the default view text size when the phone takes over', () => {
        expect(leasedTerminalScale(1)).toBe(0.6);
        expect(terminalPhoneGrid({ ...phone, zoom: 1 })).toEqual({ cols: 79, rows: 69 });
    });

    it('reflows to fewer, larger cells after a pinch out', () => {
        expect(terminalPhoneGrid({ ...phone, zoom: 2 })).toEqual({ cols: 39, rows: 34 });
        expect(leasedTerminalScale(0.1)).toBe(0.3);
    });
});

describe('mobile Terminal scroll routing', () => {
    it('forwards drags to alternate-screen and mouse-reporting applications only', () => {
        expect(
            shouldForwardTerminalScroll({ bufferType: 'alternate', mouseTrackingMode: 'none' }),
        ).toBe(true);
        expect(
            shouldForwardTerminalScroll({ bufferType: 'normal', mouseTrackingMode: 'vt200' }),
        ).toBe(true);
        expect(
            shouldForwardTerminalScroll({ bufferType: 'normal', mouseTrackingMode: 'none' }),
        ).toBe(false);
    });

    it('bounds one WebView wheel frame exactly as the gateway does', () => {
        expect(TERMINAL_WHEEL_MAX_LINES).toBe(MOBILE_TERMINAL_WHEEL_MAX_LINES);
    });
});

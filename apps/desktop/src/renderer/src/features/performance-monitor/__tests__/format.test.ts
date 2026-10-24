import { describe, expect, it } from 'vitest';

import {
    clampOverlayPosition,
    formatCpu,
    formatFps,
    formatMegabytes,
    formatMilliseconds,
    fpsTone,
    frameTone,
} from '../format';
import { parseMode, parsePosition } from '../monitor-store';

describe('formatting', () => {
    it('prints one decimal like the Chromium HUD', () => {
        expect(formatFps(69.64)).toBe('69.6');
        expect(formatFps(60)).toBe('60.0');
        expect(formatMegabytes(46.52)).toBe('46.5 MB');
        expect(formatCpu(3.04)).toBe('3.0%');
    });
    it('switches milliseconds to seconds at one second', () => {
        expect(formatMilliseconds(12.34)).toBe('12.3 ms');
        expect(formatMilliseconds(250.4)).toBe('250 ms');
        expect(formatMilliseconds(1_234)).toBe('1.23 s');
    });
    it('judges rates and frames', () => {
        expect(fpsTone(0)).toBe('idle');
        expect(fpsTone(60)).toBe('good');
        expect(fpsTone(40)).toBe('warn');
        expect(fpsTone(10)).toBe('bad');
        expect(frameTone(16)).toBe('good');
        expect(frameTone(30)).toBe('warn');
        expect(frameTone(80)).toBe('bad');
    });
});

describe('clampOverlayPosition', () => {
    const card = { height: 100, width: 200 };
    const viewport = { height: 600, width: 800 };
    it('keeps the card fully inside the viewport', () => {
        expect(clampOverlayPosition({ x: -5, y: 900 }, card, viewport)).toEqual({ x: 0, y: 500 });
        expect(clampOverlayPosition({ x: 900, y: 10 }, card, viewport)).toEqual({ x: 600, y: 10 });
    });
    it('pins to the origin when the viewport is smaller than the card', () => {
        expect(clampOverlayPosition({ x: 50, y: 50 }, card, { height: 50, width: 50 })).toEqual({
            x: 0,
            y: 0,
        });
    });
});

describe('saved preferences', () => {
    it('falls back to overlay for anything but window', () => {
        expect(parseMode('window')).toBe('window');
        expect(parseMode('x')).toBe('overlay');
        expect(parseMode(null)).toBe('overlay');
    });
    it('rejects malformed positions', () => {
        expect(parsePosition('{"x":1,"y":2}')).toEqual({ x: 1, y: 2 });
        expect(parsePosition('{"x":"1","y":2}')).toBeNull();
        expect(parsePosition('nope')).toBeNull();
        expect(parsePosition(null)).toBeNull();
    });
});

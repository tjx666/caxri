import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { motionDurationMs, motionEasing, motionSettleTimeoutMs } from './motion';

/**
 * The suite runs under Vitest's `node` environment (no jsdom, see `vitest.config.ts`), so `document`/`getComputedStyle`
 * do not exist. `motionDurationMs` only ever reads one custom property off `document.documentElement` through
 * `getComputedStyle`, so a minimal stub (a fake element paired with a `getComputedStyle` that resolves properties from
 * a plain map) is enough to drive it deterministically without a full DOM, mirroring the same mock-the-boundary
 * approach as `commands/execute.test.ts`.
 */
const tokenValuesState = { current: {} as Record<string, string> };

beforeEach(() => {
    tokenValuesState.current = {};
    vi.stubGlobal('document', { documentElement: {} });
    vi.stubGlobal('getComputedStyle', () => ({
        getPropertyValue: (token: string) => tokenValuesState.current[token] ?? '',
    }));
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('motionDurationMs', () => {
    it('parses a millisecond token', () => {
        tokenValuesState.current['--motion-expand'] = '180ms';
        expect(motionDurationMs('--motion-expand')).toBe(180);
    });

    it('converts a second token to milliseconds', () => {
        tokenValuesState.current['--motion-overlay-enter'] = '0.15s';
        expect(motionDurationMs('--motion-overlay-enter')).toBe(150);
    });

    it('trims surrounding whitespace before parsing', () => {
        tokenValuesState.current['--motion-collapse'] = '  130ms  ';
        expect(motionDurationMs('--motion-collapse')).toBe(130);
    });

    it('falls back to 200ms when the token is missing', () => {
        expect(motionDurationMs('--motion-does-not-exist')).toBe(200);
    });

    it('falls back to 200ms when the token value is unparsable', () => {
        tokenValuesState.current['--motion-broken'] = 'not-a-duration';
        expect(motionDurationMs('--motion-broken')).toBe(200);
    });
});

describe('motionSettleTimeoutMs', () => {
    it('adds a 50ms safety margin to a millisecond token', () => {
        tokenValuesState.current['--motion-collapse'] = '130ms';
        expect(motionSettleTimeoutMs('--motion-collapse')).toBe(180);
    });

    it('adds a 50ms safety margin to a second token converted to milliseconds', () => {
        tokenValuesState.current['--motion-overlay-exit'] = '0.1s';
        expect(motionSettleTimeoutMs('--motion-overlay-exit')).toBe(150);
    });

    it('adds the safety margin to the 200ms fallback when the token is missing', () => {
        expect(motionSettleTimeoutMs('--motion-does-not-exist')).toBe(250);
    });
});

describe('motionEasing', () => {
    it('parses a cubic-bezier token into control points', () => {
        tokenValuesState.current['--motion-ease-enter'] = ' cubic-bezier(0.23, 1, 0.32, 1) ';
        expect(motionEasing('--motion-ease-enter')).toEqual([0.23, 1, 0.32, 1]);
    });

    it('resolves a CSS easing keyword to its control points', () => {
        tokenValuesState.current['--motion-ease-exit'] = 'ease-in';
        expect(motionEasing('--motion-ease-exit')).toEqual([0.42, 0, 1, 1]);
    });

    it('falls back to the CSS ease curve when the token is missing', () => {
        expect(motionEasing('--motion-does-not-exist')).toEqual([0.25, 0.1, 0.25, 1]);
    });

    it('falls back to the CSS ease curve for a malformed cubic-bezier', () => {
        tokenValuesState.current['--motion-broken'] = 'cubic-bezier(0.2, nope, 0.3)';
        expect(motionEasing('--motion-broken')).toEqual([0.25, 0.1, 0.25, 1]);
    });
});

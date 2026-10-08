import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { motionDurationMs, motionSettleTimeoutMs } from './motion';

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

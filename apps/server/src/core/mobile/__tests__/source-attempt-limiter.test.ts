import { describe, expect, it } from 'vitest';

import {
    MAXIMUM_SOURCE_ATTEMPT_KEYS,
    MAXIMUM_SOURCE_ATTEMPTS,
    SOURCE_ATTEMPT_WINDOW_MS,
    SourceAttemptLimiter,
} from '../gateway/source-attempt-limiter';

describe('SourceAttemptLimiter', () => {
    it('admits a source until the per-window attempt cap, then denies further attempts', () => {
        const limiter = new SourceAttemptLimiter({ now: () => 1_000 });

        for (let attempt = 0; attempt < MAXIMUM_SOURCE_ATTEMPTS; attempt += 1)
            expect(limiter.admit('127.0.0.1')).toBe(true);
        expect(limiter.admit('127.0.0.1')).toBe(false);
        expect(limiter.size).toBe(1);
    });

    it('starts a fresh window after the previous one expires and reinserts the source as newest', () => {
        let now = 1_000;
        const limiter = new SourceAttemptLimiter({ now: () => now });
        expect(limiter.admit('10.0.0.1')).toBe(true);
        expect(limiter.admit('10.0.0.2')).toBe(true);
        now += SOURCE_ATTEMPT_WINDOW_MS;
        expect(limiter.admit('10.0.0.1')).toBe(true);
        expect(limiter.size).toBe(1);
        expect(limiter.admit('10.0.0.2')).toBe(true);
        expect(limiter.size).toBe(2);
    });

    it('evicts the oldest live source when the distinct-source cap is reached', () => {
        const limiter = new SourceAttemptLimiter({ now: () => 1_000 });
        for (let index = 0; index < MAXIMUM_SOURCE_ATTEMPT_KEYS; index += 1)
            expect(limiter.admit(`10.0.0.${index}`)).toBe(true);
        expect(limiter.size).toBe(MAXIMUM_SOURCE_ATTEMPT_KEYS);
        expect(limiter.admit('10.1.0.1')).toBe(true);
        expect(limiter.size).toBe(MAXIMUM_SOURCE_ATTEMPT_KEYS);
        for (let attempt = 0; attempt < MAXIMUM_SOURCE_ATTEMPTS; attempt += 1)
            expect(limiter.admit('10.0.0.0')).toBe(true);
    });

    it('drops every remembered source on clear', () => {
        const limiter = new SourceAttemptLimiter({ now: () => 1_000 });
        expect(limiter.admit('127.0.0.1')).toBe(true);
        limiter.clear();
        expect(limiter.size).toBe(0);
        for (let attempt = 0; attempt < MAXIMUM_SOURCE_ATTEMPTS; attempt += 1)
            expect(limiter.admit('127.0.0.1')).toBe(true);
    });
});

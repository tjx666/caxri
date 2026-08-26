import { describe, expect, it } from 'vitest';

import { resolveLogLevel } from '../log-level';

describe('resolveLogLevel', () => {
    it('uses production logging for normal packaged launches', () => {
        expect(resolveLogLevel({ environment: {}, isPackaged: true })).toBe('info');
    });

    it('retains debug logging for development and explicit packaged benchmarks', () => {
        expect(resolveLogLevel({ environment: {}, isPackaged: false })).toBe('debug');
        expect(resolveLogLevel({ environment: { CAXRI_E2E: '1' }, isPackaged: true })).toBe(
            'debug',
        );
    });
});

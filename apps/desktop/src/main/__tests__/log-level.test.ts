import { describe, expect, it } from 'vitest';

import { resolveDesktopLogLevel } from '../log-level';

describe('resolveDesktopLogLevel', () => {
    it('uses production logging for normal packaged launches', () => {
        expect(resolveDesktopLogLevel({ environment: {}, isPackaged: true })).toBe('info');
    });

    it('retains debug logging for development and explicit packaged benchmarks', () => {
        expect(resolveDesktopLogLevel({ environment: {}, isPackaged: false })).toBe('debug');
        expect(resolveDesktopLogLevel({ environment: { CAXRI_E2E: '1' }, isPackaged: true })).toBe(
            'debug',
        );
    });

    it('lets a packaged debugging session recover debug records without a rebuild', () => {
        expect(
            resolveDesktopLogLevel({
                environment: { CAXRI_LOG_LEVEL: 'debug' },
                isPackaged: true,
            }),
        ).toBe('debug');
    });

    it('lets an override quieten a development launch too', () => {
        expect(
            resolveDesktopLogLevel({ environment: { CAXRI_LOG_LEVEL: 'warn' }, isPackaged: false }),
        ).toBe('warn');
    });
});

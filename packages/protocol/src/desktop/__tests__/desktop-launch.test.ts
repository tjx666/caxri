import { describe, expect, it } from 'vitest';

import { HOST_DESKTOP_LAUNCH_ENVIRONMENT_KEY, hostDesktopLaunchSchema } from '../desktop-launch';

describe('hostDesktopLaunchSchema', () => {
    const base = { executable: '/private/caxri/Caxri', cwd: '/private/caxri' };

    it('accepts a bounded argv array', () => {
        expect(hostDesktopLaunchSchema.safeParse({ ...base, args: ['--flag'] }).success).toBe(true);
        expect(hostDesktopLaunchSchema.safeParse({ ...base, args: [] }).success).toBe(true);
    });

    it('rejects an argv array over the bounded argument count', () => {
        const arguments_ = Array.from({ length: 33 }, (_unused, index) => `--flag-${index}`);
        expect(hostDesktopLaunchSchema.safeParse({ ...base, args: arguments_ }).success).toBe(
            false,
        );
    });

    it('requires a non-empty executable and cwd path', () => {
        expect(
            hostDesktopLaunchSchema.safeParse({ executable: '', cwd: base.cwd, args: [] }).success,
        ).toBe(false);
        expect(
            hostDesktopLaunchSchema.safeParse({ executable: base.executable, cwd: '', args: [] })
                .success,
        ).toBe(false);
    });
});

describe('HOST_DESKTOP_LAUNCH_ENVIRONMENT_KEY', () => {
    it('is a stable, non-empty environment variable name', () => {
        expect(HOST_DESKTOP_LAUNCH_ENVIRONMENT_KEY).toBe('CAXRI_DESKTOP_LAUNCH');
    });
});

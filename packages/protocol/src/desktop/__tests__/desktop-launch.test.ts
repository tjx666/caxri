import { describe, expect, it } from 'vitest';

import {
    SERVER_DESKTOP_LAUNCH_ENVIRONMENT_KEY,
    serverDesktopLaunchSchema,
} from '../desktop-launch';

describe('serverDesktopLaunchSchema', () => {
    const base = { executable: '/private/caxri/Caxri', cwd: '/private/caxri' };

    it('accepts a bounded argv array', () => {
        expect(serverDesktopLaunchSchema.safeParse({ ...base, args: ['--flag'] }).success).toBe(
            true,
        );
        expect(serverDesktopLaunchSchema.safeParse({ ...base, args: [] }).success).toBe(true);
    });

    it('rejects an argv array over the bounded argument count', () => {
        const arguments_ = Array.from({ length: 33 }, (_unused, index) => `--flag-${index}`);
        expect(serverDesktopLaunchSchema.safeParse({ ...base, args: arguments_ }).success).toBe(
            false,
        );
    });

    it('requires a non-empty executable and cwd path', () => {
        expect(
            serverDesktopLaunchSchema.safeParse({ executable: '', cwd: base.cwd, args: [] })
                .success,
        ).toBe(false);
        expect(
            serverDesktopLaunchSchema.safeParse({ executable: base.executable, cwd: '', args: [] })
                .success,
        ).toBe(false);
    });
});

describe('SERVER_DESKTOP_LAUNCH_ENVIRONMENT_KEY', () => {
    it('is a stable, non-empty environment variable name', () => {
        expect(SERVER_DESKTOP_LAUNCH_ENVIRONMENT_KEY).toBe('CAXRI_DESKTOP_LAUNCH');
    });
});

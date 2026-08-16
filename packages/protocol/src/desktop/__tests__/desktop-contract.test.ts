import { describe, expect, it } from 'vitest';

import {
    desktopHostMethods,
    desktopOpenParametersSchema,
    desktopStatusResultSchema,
} from '../desktop-contract';

describe('desktopStatusResultSchema', () => {
    it('accepts the offline state without a generation', () => {
        expect(desktopStatusResultSchema.safeParse({ state: 'offline' }).success).toBe(true);
    });

    it('requires a positive generation for background/window states', () => {
        expect(
            desktopStatusResultSchema.safeParse({ state: 'window', generation: 1 }).success,
        ).toBe(true);
        expect(
            desktopStatusResultSchema.safeParse({ state: 'background', generation: 0 }).success,
        ).toBe(false);
        expect(desktopStatusResultSchema.safeParse({ state: 'window' }).success).toBe(false);
    });

    it('rejects an unrecognized state literal', () => {
        expect(desktopStatusResultSchema.safeParse({ state: 'minimized' }).success).toBe(false);
    });
});

describe('desktopOpenParametersSchema', () => {
    it('defaults launchIfNeeded to true when omitted', () => {
        expect(desktopOpenParametersSchema.parse({ path: '/private/project' })).toMatchObject({
            launchIfNeeded: true,
        });
    });

    it('lets a caller opt out of launching', () => {
        expect(
            desktopOpenParametersSchema.parse({
                path: '/private/project',
                launchIfNeeded: false,
            }),
        ).toMatchObject({ launchIfNeeded: false });
    });
});

describe('desktopHostMethods policy', () => {
    it('routes every entry through the host and gates it behind the desktop.window capability', () => {
        for (const [name, spec] of Object.entries(desktopHostMethods)) {
            expect(spec.owner, name).toBe('host');
            expect(spec.requiredCapabilities, name).toEqual(['desktop.window']);
        }
    });

    it('defaults desktop.focus params to not launching a new Desktop', () => {
        expect(desktopHostMethods['desktop.focus'].params.parse(undefined)).toEqual({
            launchIfNeeded: false,
        });
    });
});

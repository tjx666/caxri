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

    it('accepts a numeric expected file/root identity and editor location', () => {
        expect(
            desktopOpenParametersSchema.parse({
                expectedIdentity: {
                    device: '2',
                    inode: '20',
                    root: { path: '/private/project', device: '1', inode: '10' },
                },
                location: { mode: 'line', startLine: 12, endLine: 14 },
                path: '/private/project/file.ts',
            }),
        ).toMatchObject({
            expectedIdentity: { inode: '20', root: { inode: '10' } },
            location: { mode: 'line', startLine: 12, endLine: 14 },
        });
        expect(
            desktopOpenParametersSchema.safeParse({
                expectedIdentity: {
                    device: '2',
                    inode: 'replaced',
                    root: { path: '/private/project', device: '1', inode: '10' },
                },
                path: '/private/project/file.ts',
            }).success,
        ).toBe(false);
    });
});

describe('desktopHostMethods policy', () => {
    it('routes every entry through the host and gates it behind the desktop.window capability', () => {
        for (const [name, spec] of Object.entries(desktopHostMethods)) {
            expect(spec.owner, name).toBe('server');
            expect(spec.requiredCapabilities, name).toEqual(['desktop.window']);
        }
    });

    it('defaults desktop.focus params to not launching a new Desktop', () => {
        expect(desktopHostMethods['desktop.focus'].params.parse(undefined)).toEqual({
            launchIfNeeded: false,
        });
    });
});

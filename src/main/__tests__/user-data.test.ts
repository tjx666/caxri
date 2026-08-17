import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveUserDataPath } from '../user-data';

describe('resolveUserDataPath', () => {
    it('pins unpackaged launches to an isolated dev profile', () => {
        expect(resolveUserDataPath({ appDataPath: '/app-data', isPackaged: false })).toBe(
            join('/app-data', 'caxri-dev'),
        );
    });

    it('keeps the packaged default profile untouched', () => {
        expect(resolveUserDataPath({ appDataPath: '/app-data', isPackaged: true })).toBeUndefined();
    });

    it.each([true, false])(
        'prefers the explicit CAXRI_USER_DATA_DIR override (isPackaged: %s)',
        (isPackaged) => {
            expect(
                resolveUserDataPath({
                    appDataPath: '/app-data',
                    environmentOverride: '/profiles/e2e',
                    isPackaged,
                }),
            ).toBe('/profiles/e2e');
        },
    );
});

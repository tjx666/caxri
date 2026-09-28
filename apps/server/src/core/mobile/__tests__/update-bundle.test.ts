import { describe, expect, it } from 'vitest';

import { mobileUpdateDirectoryForServer } from '../update-bundle';

describe('mobileUpdateDirectoryForServer', () => {
    it('finds the packaged bundle beside the Server bundles without Electron resourcesPath', () => {
        expect(
            mobileUpdateDirectoryForServer({
                environment: {},
                serverBundleDirectory: '/Applications/Caxri.app/Contents/Resources/server/bundles',
            }),
        ).toBe('/Applications/Caxri.app/Contents/Resources/mobile');
    });

    it('prefers the development override', () => {
        expect(
            mobileUpdateDirectoryForServer({
                environment: { CAXRI_MOBILE_UPDATE_DIRECTORY: '/tmp/mobile-update' },
                serverBundleDirectory: '/Applications/Caxri.app/Contents/Resources/server/bundles',
            }),
        ).toBe('/tmp/mobile-update');
    });
});

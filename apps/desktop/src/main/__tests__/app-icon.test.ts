import { describe, expect, it } from 'vitest';

import { resolveDevelopmentDockIconPath } from '../app-icon';

describe('resolveDevelopmentDockIconPath', () => {
    it('loads the repository icon for a macOS development launch', () => {
        expect(
            resolveDevelopmentDockIconPath({
                currentDirectory: '/project/out/main',
                isPackaged: false,
                platform: 'darwin',
            }),
        ).toBe('/project/build/icon-dev.png');
    });

    it('keeps packaged and non-macOS launches on their native icon path', () => {
        expect(
            resolveDevelopmentDockIconPath({
                currentDirectory: '/application/out/main',
                isPackaged: true,
                platform: 'darwin',
            }),
        ).toBeUndefined();
        expect(
            resolveDevelopmentDockIconPath({
                currentDirectory: '/project/out/main',
                isPackaged: false,
                platform: 'linux',
            }),
        ).toBeUndefined();
    });
});

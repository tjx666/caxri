import { describe, expect, it } from 'vitest';

import { resolveDevelopmentDockIconPath, resolveNotificationAppIconPath } from '../app-icon';

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

describe('resolveNotificationAppIconPath', () => {
    it('uses the rounded bundled notification icon in a packaged app and the Dock icon in development', () => {
        expect(
            resolveNotificationAppIconPath({
                currentDirectory: '/application/out/main',
                isPackaged: true,
                resourcesPath: '/Applications/Caxri.app/Contents/Resources',
            }),
        ).toBe('/Applications/Caxri.app/Contents/Resources/notification-icon.png');
        expect(
            resolveNotificationAppIconPath({
                currentDirectory: '/project/out/main',
                isPackaged: false,
                resourcesPath:
                    '/project/node_modules/electron/dist/Electron.app/Contents/Resources',
            }),
        ).toBe('/project/build/icon-dev.png');
    });
});

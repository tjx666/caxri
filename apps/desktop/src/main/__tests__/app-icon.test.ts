import process from 'node:process';

import { describe, expect, it, vi } from 'vitest';

import {
    applyDevelopmentAppIdentity,
    resolveDevelopmentDockIconPath,
    resolveNotificationAppIconPath,
} from '../app-icon';

describe('applyDevelopmentAppIdentity', () => {
    it('names an unpackaged macOS launch and leaves a packaged one alone', () => {
        const title = process.title;
        try {
            const development = { isPackaged: false, setName: vi.fn() };
            applyDevelopmentAppIdentity(development, 'darwin');
            expect(development.setName).toHaveBeenCalledWith('Caxri Desktop');
            expect(process.title).toBe('Caxri Dev');

            const packaged = { isPackaged: true, setName: vi.fn() };
            applyDevelopmentAppIdentity(packaged, 'darwin');
            expect(packaged.setName).not.toHaveBeenCalled();
        } finally {
            process.title = title;
        }
    });
});

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

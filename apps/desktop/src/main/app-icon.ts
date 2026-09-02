import { join, resolve } from 'node:path';
import process from 'node:process';

interface DevelopmentDockIconPathOptions {
    currentDirectory: string;
    isPackaged: boolean;
    platform?: NodeJS.Platform;
}

/**
 * Packaged apps get their Dock icon from the bundle; development launches need an explicit icon.
 */
export function resolveDevelopmentDockIconPath({
    currentDirectory,
    isPackaged,
    platform = process.platform,
}: DevelopmentDockIconPathOptions): string | undefined {
    if (isPackaged || platform !== 'darwin') return undefined;
    return resolve(currentDirectory, '../..', 'build/icon-dev.png');
}

interface NotificationAppIconPathOptions {
    currentDirectory: string;
    isPackaged: boolean;
    resourcesPath: string;
}

/**
 * Icon shown by the alerter notification fallback. A packaged bundle ships `build/icon.icns` as
 * `Contents/Resources/icon.icns` (electron-builder copies the macOS icon there automatically); development launches
 * reuse the Dock icon so notifications match the Dock. Without an explicit icon alerter shows its own Terminal glyph.
 */
export function resolveNotificationAppIconPath({
    currentDirectory,
    isPackaged,
    resourcesPath,
}: NotificationAppIconPathOptions): string {
    return isPackaged
        ? join(resourcesPath, 'icon.icns')
        : resolve(currentDirectory, '../..', 'build/icon-dev.png');
}

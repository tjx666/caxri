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
 * Icon shown by the alerter notification fallback. macOS masks a full-bleed app icon into its rounded plate only for
 * the Dock and Finder; an image handed to `alerter --app-icon` is drawn as-is, so the square `icon.icns` rendered as a
 * hard-edged square in the banner. Packaged builds therefore ship `build/notification-icon.png` — the production icon
 * with the rounded plate and grid margin baked in — as an extra resource; development launches reuse the Dock icon,
 * which already carries its plate. Without an explicit icon alerter shows its own Terminal glyph.
 */
export function resolveNotificationAppIconPath({
    currentDirectory,
    isPackaged,
    resourcesPath,
}: NotificationAppIconPathOptions): string {
    return isPackaged
        ? join(resourcesPath, 'notification-icon.png')
        : resolve(currentDirectory, '../..', 'build/icon-dev.png');
}

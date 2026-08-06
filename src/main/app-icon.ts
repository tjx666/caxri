import { resolve } from 'node:path';

interface DevelopmentDockIconPathOptions {
    currentDirectory: string;
    isPackaged: boolean;
    platform?: NodeJS.Platform;
}

/** Packaged apps get their Dock icon from the bundle; development launches need an explicit icon. */
export function resolveDevelopmentDockIconPath({
    currentDirectory,
    isPackaged,
    platform = process.platform,
}: DevelopmentDockIconPathOptions): string | undefined {
    if (isPackaged || platform !== 'darwin') return undefined;
    return resolve(currentDirectory, '../..', 'build/icon-dev.png');
}

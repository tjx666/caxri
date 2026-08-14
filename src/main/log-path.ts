import { join, resolve } from 'node:path';

interface LogPathOptions {
    currentDirectory: string;
    isPackaged: boolean;
    rendererUrl?: string;
    userDataPath: string;
}

export function resolveLogDirectory({
    currentDirectory,
    isPackaged,
    rendererUrl,
    userDataPath,
}: LogPathOptions): string {
    return !isPackaged && rendererUrl
        ? resolve(currentDirectory, '../..', 'logs')
        : join(userDataPath, 'logs');
}

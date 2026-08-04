import { join, resolve } from 'node:path';

interface LogPathOptions {
    currentDirectory: string;
    rendererUrl?: string;
    userDataPath: string;
}

export function resolveLogDirectory({
    currentDirectory,
    rendererUrl,
    userDataPath,
}: LogPathOptions): string {
    return rendererUrl ? resolve(currentDirectory, '../..', 'logs') : join(userDataPath, 'logs');
}

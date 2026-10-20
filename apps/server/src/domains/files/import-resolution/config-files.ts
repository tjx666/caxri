import { stat } from 'node:fs/promises';

import { CaxriError } from '@caxri/protocol';
import { parseJsonc, readBoundedRegularFileText } from '@caxri/system';

import type { ResolvedSessionPath } from '../../project';

export function isMissingImportFile(error: unknown): boolean {
    return (
        (error instanceof CaxriError && error.code === 'NOT_FOUND') ||
        (error as NodeJS.ErrnoException).code === 'ENOENT'
    );
}

/**
 * Reauthorizes every metadata-validated cache hit; neither config nor package lookup adds filesystem authority.
 */
export class ImportConfigFiles {
    private readonly cache = new Map<string, { fingerprint: string; value: unknown }>();

    constructor(
        readonly authorize: (sessionId: string, path: string) => Promise<ResolvedSessionPath>,
    ) {}

    clear(): void {
        this.cache.clear();
    }

    async read(sessionId: string, path: string, isJsonc = false): Promise<unknown> {
        const key = `${isJsonc}:${path}`;
        try {
            const entry = await this.authorize(sessionId, path);
            const metadata = await stat(entry.path);
            if (!metadata.isFile() || metadata.size > 256 * 1024)
                throw new Error('Invalid import metadata');
            const fingerprint = [
                entry.path,
                metadata.dev,
                metadata.ino,
                metadata.size,
                metadata.mtimeMs,
                metadata.ctimeMs,
            ].join(':');
            const cached = this.cache.get(key);
            if (cached?.fingerprint === fingerprint) return cached.value;
            const text = await readBoundedRegularFileText(entry.path, 256 * 1024);
            const value: unknown = isJsonc ? parseJsonc(text) : JSON.parse(text);
            if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
            this.cache.set(key, { fingerprint, value });
            return value;
        } catch (error) {
            this.cache.delete(key);
            if (isMissingImportFile(error)) return undefined;
            throw error;
        }
    }
}

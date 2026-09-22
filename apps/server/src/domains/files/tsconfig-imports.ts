import { stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { CaxriError } from '@caxri/protocol';
import { parseJsonc } from '@caxri/system';
import { z } from 'zod';

import { readBoundedRegularFileText } from '../bounded-file-reader';
import { isOutsideRoot } from '../path-security';
import type { ResolvedSessionPath } from '../project-roots';

const configPathSchema = z.string().max(2048);
const parentListSchema = z.array(configPathSchema).max(16);
const targetListSchema = z.array(configPathSchema).max(32);
const compilerOptionsSchema = z.object({
    baseUrl: configPathSchema.optional(),
    paths: z.record(configPathSchema, targetListSchema).optional(),
});
const parentSchema = z.union([configPathSchema, parentListSchema]);
const configSchema = z.object({
    extends: parentSchema.optional(),
    compilerOptions: compilerOptionsSchema.optional(),
});

interface ImportConfig {
    baseUrl?: string;
    paths?: Record<string, string[]>;
    pathsDirectory?: string;
}

interface CachedConfig {
    fingerprint: string;
    value: z.infer<typeof configSchema>;
}

/**
 * Whether a missing candidate permits the next extension or parent lookup.
 */
function isMissing(error: unknown): boolean {
    return (
        (error instanceof CaxriError && error.code === 'NOT_FOUND') ||
        (error as NodeJS.ErrnoException).code === 'ENOENT'
    );
}

/**
 * Metadata-validated JSONC cache: every hit reauthorizes the workspace entry, and parents are revisited on each request
 * so a new nearer config or an edited inherited config takes effect without another watcher. Relative settings retain
 * their declaring config directory, as specified by TypeScript: https://www.typescriptlang.org/tsconfig/extends.html
 */
export class TsconfigImports {
    private readonly cache = new Map<string, CachedConfig>();

    constructor(
        private readonly authorize: (
            sessionId: string,
            path: string,
        ) => Promise<ResolvedSessionPath>,
    ) {}

    private async read(
        sessionId: string,
        path: string,
    ): Promise<z.infer<typeof configSchema> | undefined> {
        try {
            const entry = await this.authorize(sessionId, path);
            const metadata = await stat(entry.path);
            if (!metadata.isFile() || metadata.size > 256 * 1024)
                throw new Error('Invalid import config');
            const fingerprint = [
                entry.path,
                metadata.dev,
                metadata.ino,
                metadata.size,
                metadata.mtimeMs,
                metadata.ctimeMs,
            ].join(':');
            const cached = this.cache.get(path);
            if (cached?.fingerprint === fingerprint) return cached.value;
            const value = configSchema.parse(
                parseJsonc(await readBoundedRegularFileText(entry.path, 256 * 1024)),
            );
            if (Object.keys(value.compilerOptions?.paths ?? {}).length > 128)
                throw new Error('Too many import aliases');
            if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
            this.cache.set(path, { fingerprint, value });
            return value;
        } catch (error) {
            this.cache.delete(path);
            if (isMissing(error)) return undefined;
            throw error;
        }
    }

    private async inherit(
        sessionId: string,
        path: string,
        seen: Set<string>,
        budget: { remaining: number },
    ): Promise<ImportConfig | undefined> {
        if (seen.has(path) || seen.size >= 16 || budget.remaining-- <= 0)
            throw new Error('Import config inheritance exceeds its budget');
        const value = await this.read(sessionId, path);
        if (!value) return undefined;
        const nextSeen = new Set(seen).add(path);
        let inherited: ImportConfig = {};
        const parents = typeof value.extends === 'string' ? [value.extends] : (value.extends ?? []);
        /* eslint-disable no-await-in-loop -- later parents override earlier options */
        for (const parent of parents) {
            if (!/^\.{1,2}\//u.test(parent)) throw new Error('Unsupported import config parent');
            const parentPath = resolve(dirname(path), parent);

            // oxlint-disable-next-line react-doctor/async-await-in-loop
            const base = await this.inherit(
                sessionId,
                parentPath.endsWith('.json') ? parentPath : `${parentPath}.json`,
                nextSeen,
                budget,
            );
            if (!base) throw new Error('Missing import config parent');
            inherited = { ...inherited, ...base };
        }
        /* eslint-enable no-await-in-loop */
        const options = value.compilerOptions;
        return {
            ...inherited,
            ...(options?.baseUrl !== undefined && {
                baseUrl: resolve(dirname(path), options.baseUrl),
            }),
            ...(options?.paths !== undefined && {
                paths: options.paths,
                pathsDirectory: dirname(path),
            }),
        };
    }

    clear(): void {
        this.cache.clear();
    }

    async load(sessionId: string, from: ResolvedSessionPath): Promise<ImportConfig | undefined> {
        let directory = dirname(from.workspacePath ?? from.path);
        const budget = { remaining: 128 };
        try {
            /* eslint-disable no-await-in-loop -- the nearest existing config wins */
            for (
                let depth = 0;
                depth < 128 && !isOutsideRoot(relative(from.root, directory));
                depth += 1
            ) {
                // oxlint-disable-next-line react-doctor/async-await-in-loop
                const config = await this.inherit(
                    sessionId,
                    join(directory, 'tsconfig.json'),
                    new Set(),
                    budget,
                );
                if (config) return config;
                if (directory === from.root) break;
                directory = dirname(directory);
            }
            /* eslint-enable no-await-in-loop */
        } catch {
            // Invalid or inaccessible configs produce no speculative editor links, never a fallback outside authority.
        }
        return undefined;
    }
}

/**
 * Paths chooses the exact key, otherwise the wildcard with the longest literal prefix; target order is preserved.
 */
export function tsconfigImportTargets(
    config: ImportConfig | undefined,
    specifier: string,
): string[] {
    if (!config || !specifier || /^[./\\]|:/u.test(specifier) || specifier.includes('\0'))
        return [];
    const paths = config.paths ?? {};
    const match = Object.keys(paths)
        .filter((key) => {
            const parts = key.split('*');
            return parts.length === 1
                ? key === specifier
                : parts.length === 2 &&
                      specifier.startsWith(parts[0]) &&
                      specifier.endsWith(parts[1]) &&
                      specifier.length >= key.length - 1;
        })
        .toSorted((left, right) => {
            if (left === specifier) return -1;
            if (right === specifier) return 1;
            return right.indexOf('*') - left.indexOf('*');
        })[0];
    if (match) {
        const star = match.indexOf('*');
        const captured =
            star === -1 ? '' : specifier.slice(star, specifier.length - (match.length - star - 1));
        const base = config.baseUrl ?? config.pathsDirectory!;
        return paths[match].map((target) =>
            resolve(
                base,
                target.replace('*', () => captured),
            ),
        );
    }
    return config.baseUrl ? [resolve(config.baseUrl, specifier)] : [];
}

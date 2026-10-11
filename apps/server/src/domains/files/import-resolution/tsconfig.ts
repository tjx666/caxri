import { dirname, join, relative, resolve } from 'node:path';

import { z } from 'zod';

import { isOutsideRoot } from '../../path-security';
import type { ResolvedSessionPath } from '../../project';
import type { ImportConfigFiles } from './config-files';
import type { PackageImports } from './packages';

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

/**
 * Metadata-validated JSONC cache: every hit reauthorizes the workspace entry, and parents are revisited on each request
 * so a new nearer config or an edited inherited config takes effect without another watcher. Relative settings retain
 * their declaring config directory, as specified by TypeScript: https://www.typescriptlang.org/tsconfig/extends.html
 */
export class TsconfigImports {
    constructor(
        private readonly files: ImportConfigFiles,
        private readonly packages: PackageImports,
    ) {}

    private async resolveParent(
        sessionId: string,
        root: string,
        path: string,
        parent: string,
    ): Promise<string> {
        if (/^\.{1,2}\//u.test(parent)) {
            const candidate = resolve(dirname(path), parent);
            return candidate.endsWith('.json') ? candidate : `${candidate}.json`;
        }
        const candidate = await this.packages.configPath(
            sessionId,
            { root, path, workspacePath: path },
            parent,
        );
        if (!candidate) throw new Error('Missing import config package');
        return candidate;
    }

    private async inherit(
        sessionId: string,
        path: string,
        root: string,
        seen: Set<string>,
        budget: { remaining: number },
    ): Promise<ImportConfig | undefined> {
        if (seen.has(path) || seen.size >= 16 || budget.remaining-- <= 0)
            throw new Error('Import config inheritance exceeds its budget');
        const raw = await this.files.read(sessionId, path, true);
        if (raw === undefined) return undefined;
        const value = configSchema.parse(raw);
        if (Object.keys(value.compilerOptions?.paths ?? {}).length > 128)
            throw new Error('Too many import aliases');
        const nextSeen = new Set(seen).add(path);
        let inherited: ImportConfig = {};
        const parents = typeof value.extends === 'string' ? [value.extends] : (value.extends ?? []);
        /* eslint-disable no-await-in-loop -- later parents override earlier options */
        for (const parent of parents) {
            // oxlint-disable-next-line react-doctor/async-await-in-loop
            const parentPath = await this.resolveParent(sessionId, root, path, parent);

            // oxlint-disable-next-line react-doctor/async-await-in-loop
            const base = await this.inherit(sessionId, parentPath, root, nextSeen, budget);
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
                    from.root,
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

import { stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { isOutsideRoot } from '../../path-security';
import type { ResolvedSessionPath } from '../../project';
import { importCandidatePaths } from './candidates';
import type { ImportConfigFiles } from './config-files';
import { isMissingImportFile } from './config-files';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function isExistingDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Only lexical package names/subpaths are admitted; encoded traversal and filesystem paths are not packages.
 */
function packageParts(specifier: string): { name: string; subpath: string } | undefined {
    if (!specifier || /[\\:\s\0%]/u.test(specifier)) return undefined;
    const parts = specifier.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || part === 'node_modules'))
        return undefined;
    const count = specifier.startsWith('@') ? 2 : 1;
    if (parts.length < count || (count === 2 && parts[0] === '@')) return undefined;
    return { name: parts.slice(0, count).join('/'), subpath: parts.slice(count).join('/') };
}

/**
 * Types are preferred for inspection; runtime conditions supply a fallback when no declaration target exists.
 */
function conditionalTargets(value: unknown, depth = 0): string[] {
    if (depth >= 8) return [];
    if (typeof value === 'string') return value.length <= 2048 ? [value] : [];
    if (Array.isArray(value))
        return value
            .slice(0, 32)
            .flatMap((entry) => conditionalTargets(entry, depth + 1))
            .slice(0, 64);
    if (!isRecord(value)) return [];
    const runtime = ['import', 'node', 'default', 'require'].find((key) =>
        Object.hasOwn(value, key),
    );
    return [
        ...conditionalTargets(value.types, depth + 1),
        ...(runtime ? conditionalTargets(value[runtime], depth + 1) : []),
    ].slice(0, 64);
}

/**
 * Supports explicit/subpath-pattern exports without bypassing a package's export boundary. Null or unmatched exports
 * never fall through to legacy main/index entries. https://nodejs.org/api/packages.html#subpath-exports
 */
export function packageEntryTargets(metadata: unknown, subpath: string): string[] {
    if (!isRecord(metadata)) return subpath ? [`./${subpath}`] : ['./index'];
    if (!Object.hasOwn(metadata, 'exports')) {
        if (subpath) return [`./${subpath}`];
        return ['types', 'typings', 'main', 'module']
            .flatMap((field) => {
                const value = metadata[field];
                return typeof value === 'string' && value.length <= 2048 ? [value] : [];
            })
            .concat('./index');
    }
    const value = metadata.exports;
    const key = subpath ? `./${subpath}` : '.';
    if (!isRecord(value) || Object.keys(value).every((entry) => !entry.startsWith('.'))) {
        return subpath ? [] : conditionalTargets(value).filter(isValidExportTarget);
    }
    if (Object.hasOwn(value, key))
        return conditionalTargets(value[key]).filter(isValidExportTarget);
    const pattern = Object.keys(value)
        .filter((entry) => {
            const parts = entry.split('*', 3);
            const [prefix, suffix] = parts;
            return (
                parts.length === 2 &&
                key.startsWith(prefix) &&
                key.endsWith(suffix) &&
                key.length >= entry.length - 1
            );
        })
        .toSorted(
            (left, right) => right.indexOf('*') - left.indexOf('*') || right.length - left.length,
        )[0];
    if (!pattern) return [];
    const star = pattern.indexOf('*');
    const captured = key.slice(star, key.length - (pattern.length - star - 1));
    return conditionalTargets(value[pattern])
        .map((target) => target.replaceAll('*', () => captured))
        .filter(isValidExportTarget);
}

function isValidExportTarget(target: string): boolean {
    return (
        target.startsWith('./') &&
        !/[\\%\0]/u.test(target) &&
        target
            .slice(2)
            .split('/')
            .every((part) => !['..', '.', 'node_modules'].includes(part))
    );
}

/**
 * Keep declarations ahead of compiled output while leaving relative/workspace source precedence unchanged.
 */
export function packageFileCandidates(path: string): string[] {
    if (/\.d\.[cm]?ts$/u.test(path)) return [path];
    const declarations =
        path.endsWith('.mjs') || path.endsWith('.mts')
            ? [`${path.slice(0, -4)}.d.mts`]
            : path.endsWith('.cjs') || path.endsWith('.cts')
              ? [`${path.slice(0, -4)}.d.cts`]
              : /\.[jt]sx?$/u.test(path) && !path.endsWith('.d.ts')
                ? [path.replace(/\.[jt]sx?$/u, '.d.ts')]
                : [`${path}.d.ts`];
    return [
        ...new Set([
            ...declarations,
            path,
            join(path, 'index.d.ts'),
            ...importCandidatePaths(path),
        ]),
    ];
}

export class PackageImports {
    constructor(private readonly files: ImportConfigFiles) {}

    /**
     * Walks the ancestors of the importing file looking for `node_modules/<name>`.
     *
     * Almost every level is a miss, and a miss must stay cheap: this runs per bare specifier, for every open document,
     * on Monaco's debounced link pass. Authorization is therefore attempted only once a directory is actually there.
     * `packageParts` has already rejected traversal and separators, and the loop never leaves the Project root, so the
     * probe path is lexically inside the root; it reveals only whether an entry exists. Authorization still runs, on
     * the same path, before anything is resolved or read, so which package roots are admitted does not change.
     */
    private async find(
        sessionId: string,
        from: ResolvedSessionPath,
        name: string,
    ): Promise<{ root: string; metadata: unknown } | undefined> {
        let directory = dirname(from.workspacePath ?? from.path);
        /* eslint-disable no-await-in-loop -- nearest installed package owns resolution and metadata */
        for (
            let depth = 0;
            depth < 128 && !isOutsideRoot(relative(from.root, directory));
            depth += 1
        ) {
            const packageRoot = join(directory, 'node_modules', name);
            try {
                // oxlint-disable-next-line react-doctor/async-await-in-loop
                if (!(await isExistingDirectory(packageRoot))) {
                    if (directory === from.root) break;
                    directory = dirname(directory);
                    continue;
                }
                // oxlint-disable-next-line react-doctor/async-await-in-loop
                const entry = await this.files.authorize(sessionId, packageRoot);
                // oxlint-disable-next-line react-doctor/async-await-in-loop
                if ((await stat(entry.path)).isDirectory()) {
                    // oxlint-disable-next-line react-doctor/async-await-in-loop
                    const metadata = await this.files.read(
                        sessionId,
                        join(packageRoot, 'package.json'),
                    );
                    return { root: entry.workspacePath ?? entry.path, metadata };
                }
            } catch (error) {
                if (!isMissingImportFile(error)) throw error;
            }
            if (directory === from.root) break;
            directory = dirname(directory);
        }
        /* eslint-enable no-await-in-loop */
        return undefined;
    }

    async candidates(
        sessionId: string,
        from: ResolvedSessionPath,
        specifier: string,
    ): Promise<string[]> {
        const parts = packageParts(specifier);
        if (!parts) return [];
        try {
            const found = await this.find(sessionId, from, parts.name);
            if (!found) return [];
            return packageEntryTargets(found.metadata, parts.subpath).flatMap((target) => {
                const path = resolve(found.root, target);
                return isOutsideRoot(relative(found.root, path)) ? [] : packageFileCandidates(path);
            });
        } catch {
            return [];
        }
    }

    async configPath(
        sessionId: string,
        from: ResolvedSessionPath,
        specifier: string,
    ): Promise<string | undefined> {
        const parts = packageParts(specifier);
        if (!parts) return undefined;
        const found = await this.find(sessionId, from, parts.name);
        if (!found) return undefined;
        const configured = isRecord(found.metadata) ? found.metadata.tsconfig : undefined;
        const target =
            parts.subpath || (typeof configured === 'string' ? configured : 'tsconfig.json');
        const path = resolve(found.root, target.endsWith('.json') ? target : `${target}.json`);
        return isOutsideRoot(relative(found.root, path)) ? undefined : path;
    }
}

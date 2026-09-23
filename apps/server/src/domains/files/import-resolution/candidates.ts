import { dirname, resolve } from 'node:path';

/**
 * Extensions a module specifier may be written without, in the order a TypeScript or bundler resolver tries them.
 * TypeScript wins over JavaScript because a source tree that has both is being read through its sources here.
 */
const IMPORT_CANDIDATE_EXTENSIONS = [
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.d.ts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.json',
] as const;

/**
 * ESM TypeScript is written with the emitted JavaScript extension (`from './domain.js'`) while the file on disk is
 * `domain.ts`, so each of these also stands for its TypeScript source. Without this the repository's own protocol
 * imports would resolve to nothing.
 */
const TYPESCRIPT_SOURCE_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
    '.js': ['.ts', '.tsx'],
    '.jsx': ['.tsx'],
    '.mjs': ['.mts'],
    '.cjs': ['.cts'],
};

function typescriptSourceCandidates(target: string): string[] {
    for (const [emitted, sources] of Object.entries(TYPESCRIPT_SOURCE_EXTENSIONS)) {
        if (!target.endsWith(emitted)) continue;
        const stem = target.slice(0, -emitted.length);
        return sources.map((extension) => `${stem}${extension}`);
    }
    return [];
}

/**
 * Whether a module specifier names a file relative to the importing document rather than a package or a `tsconfig` path
 * alias. Only these are resolvable without a project graph, which is the boundary this feature deliberately keeps.
 */
export function isRelativeImportSpecifier(specifier: string): boolean {
    return /^\.{1,2}\//u.test(specifier) && !specifier.includes('\0');
}

/**
 * Filesystem paths one relative specifier could name, most likely first. The caller probes them in order and takes the
 * first regular file, which is what makes `'../../errors'` open either `errors.ts` or `errors/index.ts` without the
 * caller knowing which layout the target uses.
 *
 * Returns nothing for a specifier this feature does not resolve, so a caller cannot accidentally turn a package name
 * into a filesystem probe.
 */
export function relativeImportCandidatePaths(fromPath: string, specifier: string): string[] {
    if (!isRelativeImportSpecifier(specifier)) return [];
    const target = resolve(dirname(fromPath), specifier);
    return importCandidatePaths(target);
}

/**
 * Expands an already selected relative or alias target using the same source-extension order.
 */
export function importCandidatePaths(target: string): string[] {
    const candidates = [
        target,
        ...typescriptSourceCandidates(target),
        ...IMPORT_CANDIDATE_EXTENSIONS.map((extension) => `${target}${extension}`),
        ...IMPORT_CANDIDATE_EXTENSIONS.map((extension) => `${target}/index${extension}`),
    ];
    return [...new Set(candidates)];
}

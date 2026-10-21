import { basename, extname } from 'node:path';

/**
 * The subset of check options that decides which repository-wide gates a run adds.
 */
interface GateSelection {
    isDefaultSelection: boolean;
    knip: boolean;
    type: boolean;
}

const TYPE_SOURCE_EXTENSIONS = new Set(['.cts', '.mts', '.ts', '.tsx']);
const TYPE_INPUT_FILES = new Set(['package.json', 'pnpm-lock.yaml']);

/**
 * Whether a changed path can change what TypeScript reports: a source, a `tsconfig*.json`, or a manifest or lockfile
 * that moves a dependency's types. Deleted paths count too, since removing a module breaks every importer.
 */
export function canAffectTypes(file: string): boolean {
    const name = basename(file);
    return (
        TYPE_SOURCE_EXTENSIONS.has(extname(name).toLowerCase()) ||
        TYPE_INPUT_FILES.has(name) ||
        /^tsconfig.*\.json$/.test(name)
    );
}

/**
 * The default selection adds the repository-wide typecheck (about 16 seconds) only when a changed path can affect
 * types; lint and related tests alone once passed a change whose type error then failed CI's `checks` job.
 */
export function shouldTypecheck(options: GateSelection, changedFiles: readonly string[]): boolean {
    return options.type || (options.isDefaultSelection && changedFiles.some(canAffectTypes));
}

/**
 * The default selection also adds `knip` (a few seconds, repository-wide) for the same paths. An export left with no
 * importer passes lint, related tests, and typecheck, and only CI's `checks` job used to catch it.
 */
export function shouldRunKnip(options: GateSelection, changedFiles: readonly string[]): boolean {
    return options.knip || (options.isDefaultSelection && changedFiles.some(canAffectTypes));
}

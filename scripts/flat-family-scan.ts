import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

/**
 * Finds flat filename families across every workspace source tree: production modules in one directory that share the
 * prefix before their first hyphen. `source-layout` moves a cohesive cluster of three or more modules into its own
 * directory; the hand-listed caps in `directory-density-baseline.ts` only see the owners someone remembered to add, so
 * a family such as `agent-delegation/retry-*` grew to eight modules at an unlisted domain root.
 */

/**
 * A family reaching this many direct production modules must move into its own directory or be listed in
 * `KNOWN_FLAT_FAMILIES`. Six keeps the guard on real clusters: four would flag 167 existing families, most of them a
 * parent-name prefix kept for readability.
 */
export const FLAT_FAMILY_THRESHOLD = 6;

/**
 * Workspace roots whose `src` trees are scanned.
 */
const WORKSPACE_ROOTS = ['apps', 'packages', 'extensions'] as const;

/**
 * Hooks are named `use-*` by convention and gathered in `hooks/` folders, so the prefix says nothing about cohesion.
 */
const IGNORED_PREFIXES = new Set(['use-']);

function isProductionModule(name: string): boolean {
    return (
        /\.tsx?$/u.test(name) &&
        !/\.(?:test|spec|fixture|e2e)\.tsx?$/u.test(name) &&
        !name.endsWith('.d.ts')
    );
}

function familyPrefixOf(name: string): string | undefined {
    if (!isProductionModule(name)) return undefined;
    const dash = name.indexOf('-');
    if (dash <= 0) return undefined;
    const prefix = name.slice(0, dash + 1);
    return IGNORED_PREFIXES.has(prefix) ? undefined : prefix;
}

/**
 * Every module's family key (`<directory>/<prefix>`) in one workspace `src` tree, skipping tests and dependencies.
 */
async function familyKeysOf(projectRoot: string, source: string): Promise<string[]> {
    let entries: Dirent[];
    try {
        entries = await readdir(resolve(projectRoot, source), {
            recursive: true,
            withFileTypes: true,
        });
    } catch (error) {
        // A workspace without a `src` tree has nothing to scan.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    return entries.flatMap((entry) => {
        const prefix = entry.isFile() ? familyPrefixOf(entry.name) : undefined;
        const directory = relative(projectRoot, entry.parentPath).replaceAll('\\', '/');
        if (prefix === undefined || /(?:^|\/)(?:__tests__|node_modules)(?:\/|$)/u.test(directory))
            return [];
        return [`${directory}/${prefix}`];
    });
}

export const FLAT_FAMILY_TEST = 'scripts/__tests__/flat-family-ratchet.test.ts';

/**
 * True when a changed path can create or shrink a family. Used by local and CI test selection: the ratchet reads the
 * filesystem, so import discovery never links it to the files it counts.
 */
export function isFlatFamilyPath(path: string): boolean {
    return /^(?:apps|packages|extensions)\/[^/]+\/src\/.+\.tsx?$/u.test(path);
}

/**
 * Every family as `<directory>/<prefix>` mapped to its module count, for each workspace's `src` tree.
 */
export async function scanFlatFamilies(projectRoot: string): Promise<Map<string, number>> {
    const workspaces = await Promise.all(
        WORKSPACE_ROOTS.map(async (root) =>
            (await readdir(resolve(projectRoot, root), { withFileTypes: true }))
                .filter((workspace) => workspace.isDirectory())
                .map((workspace) => `${root}/${workspace.name}/src`),
        ),
    );
    const keys = await Promise.all(
        workspaces.flat().map((source) => familyKeysOf(projectRoot, source)),
    );
    const families = new Map<string, number>();
    for (const key of keys.flat()) families.set(key, (families.get(key) ?? 0) + 1);
    return families;
}

if (import.meta.main) {
    const dense = [...(await scanFlatFamilies(resolve(import.meta.dirname, '..')))]
        .filter(([, count]) => count >= FLAT_FAMILY_THRESHOLD)
        .map(([family]) => family)
        .toSorted((a, b) => a.localeCompare(b));
    for (const family of dense) console.log(`    '${family}',`);
}

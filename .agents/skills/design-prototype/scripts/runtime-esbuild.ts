import { readdir } from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');

/**
 * Resolve workspace packages such as `@caxri/protocol` through their `bun` export condition, which points at `src/`, as
 * Bun and the Renderer's Vite build do. Esbuild's default `import` condition picks the gitignored `dist/` instead,
 * which in a checkout that has not rebuilt the package lacks newer exports and fails the runtime build.
 */
export const WORKSPACE_SOURCE_CONDITIONS = '--conditions=bun';

/**
 * Esbuild ships as a transitive dependency (vite); pick the newest copy in the pnpm store.
 */
export async function resolveEsbuild(): Promise<string> {
    const store = path.join(repoRoot, 'node_modules/.pnpm');
    let entries: string[];
    try {
        entries = await readdir(store);
    } catch {
        throw new Error(`pnpm store not found at ${store}: run \`ni\` first`);
    }
    const copies = entries
        .filter((name) => /^esbuild@\d/.test(name))
        .toSorted((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    const newest = copies.at(-1);
    if (!newest) throw new Error('esbuild not found in the pnpm store: run `ni` first');
    return path.join(store, newest, 'node_modules/esbuild/bin/esbuild');
}

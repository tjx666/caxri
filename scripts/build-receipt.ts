import type { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, readdir, readFile, readlink, rm } from 'node:fs/promises';
import { basename, delimiter, join } from 'node:path';
import process from 'node:process';

import { writeJsonAtomic } from './atomic-json';
import { execFileAsync } from './exec';

/**
 * Repository paths that no build step reads. Everything else, including Markdown, counts as a build input: the product
 * skill bundle embeds `skills/**\/*.md` and the Server artifact ships `THIRD_PARTY_NOTICES.md`. A missing exclusion
 * only costs a rebuild; a wrong exclusion reuses stale output, so add a prefix only after auditing every build script.
 */
export const EXCLUDED_INPUT_PREFIXES = ['.agents/', '.github/', 'docs/', 'e2e/'] as const;

/**
 * Environment variables read by `electron.vite.config.ts`, `scripts/source-map-flavor.ts`, and the Server artifact
 * scripts. They select a build flavor (profiling, Source Maps, test extension) rather than the code under test, so they
 * form a separate key. Only their digest enters the receipt, never their values.
 */
export const BUILD_ENVIRONMENT_KEYS = [
    'CAXRI_BUNDLE_ANALYZE',
    'CAXRI_LINUX_NATIVES_DIR',
    'CAXRI_REACT_PROFILING',
    'CAXRI_REACT_SCAN',
    'CAXRI_SERVER_INCLUDE_TEST_EXTENSION',
    'CAXRI_SERVER_RUNTIME_EXECUTABLE',
    'CAXRI_SOURCE_MAPS',
] as const;

/**
 * Output trees an unpackaged E2E launch consumes. Every file's size, mode, and mtime enters the digest, so a dev
 * rebuild, a partial build, or a deleted chunk invalidates the receipt even when the entry bundles survive.
 */
export const OUTPUT_ROOTS = [
    'apps/cli/dist',
    'apps/server/dist',
    'extensions/fixture/dist',
    'extensions/git/dist',
    'extensions/status/dist',
    'out/main',
    'out/preload',
    'out/renderer',
] as const;

/**
 * Entry files that must exist for a receipt to count; an empty output tree would otherwise digest consistently.
 */
export const REQUIRED_OUTPUTS = [
    'apps/cli/dist/caxri.cjs',
    'apps/server/dist/server/bundles/extension-host.js',
    'apps/server/dist/server/bundles/server-core.js',
    'apps/server/dist/server/bundles/terminal-host.js',
    'apps/server/dist/server/metadata/manifest.json',
    'extensions/fixture/dist/extension.js',
    'extensions/git/dist/extension.js',
    'extensions/status/dist/extension.js',
    'out/main/index.js',
    'out/preload/index.cjs',
    'out/renderer/index.html',
] as const;

const RECEIPT_PATH = '.cache/build-receipt.json';
const PENDING_PATH = '.cache/build-receipt.pending.json';
const RECEIPT_VERSION = 2;

interface BuildKeys {
    /**
     * Digest of the flavor-selecting build environment variables.
     */
    environmentKey: string;
    /**
     * Digest of the source, install, and toolchain the build read.
     */
    sourceKey: string;
}

interface BuildReceipt extends BuildKeys {
    outputDigest: string;
    version: number;
}

export type BuildReceiptStatus =
    | { isValid: true }
    | {
          isValid: false;
          reason:
              | 'environment-changed'
              | 'install-mismatch'
              | 'inputs-changed'
              | 'missing'
              | 'outputs-changed';
      };

function isExcludedInput(path: string): boolean {
    return EXCLUDED_INPUT_PREFIXES.some((prefix) => path.startsWith(prefix));
}

async function git(root: string, arguments_: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', arguments_, {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
}

/**
 * Code-unit order, so every process derives the same key regardless of locale.
 */
function compareText(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

/**
 * `bun --bun` and `bunx --bun` (the Android Acceptance runner starts Playwright that way) put a `bun-node-*` directory
 * first on PATH whose `node` is Bun itself, and Bun refuses `node --version` without a script. The probe skips that
 * shim so every runner reads the same installed Node.
 */
async function toolVersion(command: string): Promise<string> {
    const path = (process.env.PATH ?? '')
        .split(delimiter)
        .filter((entry) => !basename(entry).startsWith('bun-node-'))
        .join(delimiter);
    const { stdout } = await execFileAsync(command, ['--version'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: path },
    });
    return stdout.trim();
}

async function isFile(path: string): Promise<boolean> {
    try {
        return (await lstat(path)).isFile();
    } catch {
        return false;
    }
}

function splitNull(value: string): string[] {
    return value.split('\0').filter(Boolean);
}

async function readOptional(path: string): Promise<Buffer | undefined> {
    try {
        return await readFile(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

async function worktreeEntry(root: string, path: string): Promise<string> {
    let metadata: Stats;
    try {
        metadata = await lstat(join(root, path));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `${path}\0deleted`;
        throw error;
    }
    if (metadata.isSymbolicLink()) return `${path}\0link\0${await readlink(join(root, path))}`;
    if (!metadata.isFile()) return `${path}\0other\0${metadata.mode}`;
    const digest = createHash('sha256')
        .update(await readFile(join(root, path)))
        .digest('hex');
    return `${path}\0file\0${metadata.mode}\0${digest}`;
}

/**
 * Whether the installed dependency graph matches the committed lockfile. A rebuild over a stale `node_modules` would
 * still use old dependencies, so neither reuse nor a new receipt is allowed until `ni` runs.
 */
export async function isInstallCurrent(root: string): Promise<boolean> {
    const [installed, committed] = await Promise.all([
        readOptional(join(root, 'node_modules', '.pnpm', 'lock.yaml')),
        readOptional(join(root, 'pnpm-lock.yaml')),
    ]);
    return installed !== undefined && committed !== undefined && installed.equals(committed);
}

/**
 * Content key of the sources a `bun run build` reads: HEAD (both builds embed the commit), the index, uncommitted and
 * untracked worktree content, root `.env*` files that Bun loads automatically, the installed lockfile, and the
 * toolchain identity. Index entries and worktree overlays are separate sections, so staging alone can cause a
 * conservative miss but never a stale hit.
 */
export async function computeBuildSourceKey(root: string): Promise<string> {
    const [head, index, dirty, nodeVersion, bunVersion, rootEntries] = await Promise.all([
        git(root, ['rev-parse', 'HEAD']),
        git(root, ['ls-files', '--stage', '-z']),
        // `git status` refreshes stat-dirty index entries first; `ls-files --modified` would list a touched but unchanged
        // file only until something refreshes the index, making the key flap.
        git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']),
        // Resolved from PATH rather than `process.versions`: `check` runs under Bun while Playwright workers run
        // under Node, and both must derive the same key.
        toolVersion('node'),
        toolVersion('bun'),
        readdir(root),
    ]);
    const hash = createHash('sha256');
    const section = (name: string, values: Iterable<string>) => {
        hash.update(`\0section\0${name}\0`);
        for (const value of values) hash.update(`${value}\0`);
    };

    section('head', [head.trim()]);
    section(
        'index',
        splitNull(index).filter((entry) => !isExcludedInput(entry.slice(entry.indexOf('\t') + 1))),
    );
    const dirtyPaths = [...new Set(splitNull(dirty).map((record) => record.slice(3)))]
        .filter((path) => !isExcludedInput(path))
        .toSorted(compareText);
    section('worktree', await Promise.all(dirtyPaths.map((path) => worktreeEntry(root, path))));
    const environmentFiles = rootEntries
        .filter((name) => name.startsWith('.env'))
        .toSorted(compareText);
    section(
        'env-files',
        await Promise.all(environmentFiles.map((name) => worktreeEntry(root, name))),
    );
    section('toolchain', [process.platform, process.arch, nodeVersion, bunVersion]);
    const installed = await readOptional(join(root, 'node_modules', '.pnpm', 'lock.yaml'));
    section('install', [installed ? createHash('sha256').update(installed).digest('hex') : 'none']);
    return hash.digest('hex');
}

export function computeBuildEnvironmentKey(environment: NodeJS.ProcessEnv = process.env): string {
    const hash = createHash('sha256');
    for (const key of BUILD_ENVIRONMENT_KEYS)
        hash.update(`${key}=${environment[key] ?? '\0unset'}\0`);
    return hash.digest('hex');
}

async function computeBuildKeys(root: string): Promise<BuildKeys> {
    return {
        environmentKey: computeBuildEnvironmentKey(),
        sourceKey: await computeBuildSourceKey(root),
    };
}

async function collectOutputEntries(root: string, relativePath: string): Promise<string[]> {
    let metadata: Stats;
    try {
        metadata = await lstat(join(root, relativePath));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    if (!metadata.isDirectory())
        return [`${relativePath}\0${metadata.mode}\0${metadata.size}\0${metadata.mtimeMs}`];
    const names = (await readdir(join(root, relativePath))).toSorted(compareText);
    const children = await Promise.all(
        names.map((name) => collectOutputEntries(root, `${relativePath}/${name}`)),
    );
    return children.flat();
}

/**
 * Digest of the complete output trees. Returns `undefined` when a required entry is missing. Matching mtimes are not a
 * content proof: a copy that preserves timestamps is outside this contract.
 */
export async function computeOutputDigest(root: string): Promise<string | undefined> {
    const required = await Promise.all(REQUIRED_OUTPUTS.map((path) => isFile(join(root, path))));
    if (required.includes(false)) return undefined;
    const entries = await Promise.all(OUTPUT_ROOTS.map((path) => collectOutputEntries(root, path)));
    const hash = createHash('sha256');
    for (const entry of entries.flat()) hash.update(`${entry}\0`);
    return hash.digest('hex');
}

async function readJson<T>(path: string): Promise<T | undefined> {
    const content = await readOptional(path);
    if (!content) return undefined;
    try {
        return JSON.parse(content.toString('utf8')) as T;
    } catch {
        return undefined;
    }
}

/**
 * Decides whether the current build output was produced from the current sources. `reuse` (the `check --e2e` rebuild
 * decision) also requires the same build flavor, so a profiling or Source-Map-free build is never reused as the default
 * one. `launch` (refusing stale output before an Electron launch) accepts any flavor: a benchmark deliberately runs a
 * profiling build. Callers that hold sources constant for their lifetime may pass a precomputed `sourceKey` and recheck
 * only the outputs.
 */
export async function verifyBuildReceipt(
    root: string,
    options: { environment?: NodeJS.ProcessEnv; purpose: 'launch' | 'reuse'; sourceKey?: string },
): Promise<BuildReceiptStatus> {
    const receipt = await readJson<BuildReceipt>(join(root, RECEIPT_PATH));
    if (receipt?.version !== RECEIPT_VERSION) return { isValid: false, reason: 'missing' };
    if (!(await isInstallCurrent(root))) return { isValid: false, reason: 'install-mismatch' };
    if (
        options.purpose === 'reuse' &&
        receipt.environmentKey !== computeBuildEnvironmentKey(options.environment)
    )
        return { isValid: false, reason: 'environment-changed' };
    const sourceKey = options.sourceKey ?? (await computeBuildSourceKey(root));
    if (receipt.sourceKey !== sourceKey) return { isValid: false, reason: 'inputs-changed' };
    if (receipt.outputDigest !== (await computeOutputDigest(root)))
        return { isValid: false, reason: 'outputs-changed' };
    return { isValid: true };
}

/**
 * Starts a build: drops the published receipt before any output is rewritten and remembers the keys the build begins
 * from.
 */
export async function beginBuild(root: string): Promise<void> {
    await rm(join(root, RECEIPT_PATH), { force: true });
    await writeJsonAtomic(join(root, PENDING_PATH), await computeBuildKeys(root), {
        ensureParent: true,
    });
}

/**
 * Publishes a receipt only when the inputs did not change while the build ran and the install matches the lockfile.
 * Generated sources that a build rewrites converge on the next build, which then records.
 */
export async function recordBuild(
    root: string,
): Promise<'install-mismatch' | 'inputs-changed' | 'recorded'> {
    const pending = await readJson<BuildKeys>(join(root, PENDING_PATH));
    await rm(join(root, PENDING_PATH), { force: true });
    if (!(await isInstallCurrent(root))) return 'install-mismatch';
    const keys = await computeBuildKeys(root);
    if (pending?.sourceKey !== keys.sourceKey || pending.environmentKey !== keys.environmentKey)
        return 'inputs-changed';
    const outputDigest = await computeOutputDigest(root);
    if (!outputDigest) throw new Error('Build finished without its required outputs');
    await writeJsonAtomic(
        join(root, RECEIPT_PATH),
        { ...keys, outputDigest, version: RECEIPT_VERSION } satisfies BuildReceipt,
        { ensureParent: true },
    );
    return 'recorded';
}

if (import.meta.main) {
    const root = (await git(process.cwd(), ['rev-parse', '--show-toplevel'])).trim();
    const command = process.argv[2];
    if (command === 'begin') {
        await beginBuild(root);
    } else if (command === 'record') {
        const outcome = await recordBuild(root);
        if (outcome !== 'recorded')
            console.warn(`Build receipt not recorded (${outcome}); the next E2E check rebuilds.`);
    } else {
        console.error('Usage: bun run scripts/build-receipt.ts <begin|record>');
        process.exit(2);
    }
}

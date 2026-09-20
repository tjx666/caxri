import { randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';
import { gt, inc, valid } from 'semver';

export const PRODUCT_MANIFEST_PATHS = [
    'package.json',
    'apps/cli/package.json',
    'apps/desktop/package.json',
    'apps/server/package.json',
    'packages/agent-skills/package.json',
    'packages/client/package.json',
    'packages/extension-api/package.json',
] as const;

const VERSION_SOURCES = [
    { constant: 'CLI_VERSION', path: 'apps/cli/src/version.ts' },
    {
        constant: 'SKILL_BUNDLE_VERSION',
        path: 'packages/agent-skills/src/version.ts',
    },
] as const;

type ReleaseIncrement = 'major' | 'minor' | 'patch';

interface FileChange {
    nextSource: string;
    originalSource: string;
    path: string;
}

interface PackageManifest {
    engines?: { caxri?: string };
    version?: string;
}

export interface PreparedRelease {
    changedPaths: string[];
    previousVersion: string;
    version: string;
}

export type GitReader = (arguments_: string[], cwd: string) => Promise<string>;
export type ReleaseSourceReader = (path: string, cwd: string) => Promise<string>;

const defaultGitReader: GitReader = async (arguments_, cwd) => {
    const { stdout } = await execFileAsync('git', arguments_, { cwd, encoding: 'utf8' });
    return stdout.trim();
};

const defaultPreviousReleaseSourceReader: ReleaseSourceReader = async (path, cwd) => {
    const { stdout } = await execFileAsync('git', ['show', `HEAD^:${path}`], {
        cwd,
        encoding: 'utf8',
    });
    return stdout;
};

function parseManifest(source: string, path: string): PackageManifest {
    try {
        return JSON.parse(source) as PackageManifest;
    } catch (error) {
        throw new Error(`${path} is not valid JSON`, { cause: error });
    }
}

function nextVersion(currentVersion: string, target: string): string {
    if (!valid(currentVersion)) throw new Error(`Current version is not valid SemVer: ${currentVersion}`);
    if (['major', 'minor', 'patch'].includes(target)) {
        const version = inc(currentVersion, target as ReleaseIncrement);
        if (!version) throw new Error(`Cannot apply ${target} to ${currentVersion}`);
        return version;
    }

    const version = valid(target);
    if (!version) throw new Error(`Release target must be major, minor, patch, or a SemVer version`);
    if (!gt(version, currentVersion)) {
        throw new Error(`Release version ${version} must be newer than ${currentVersion}`);
    }
    return version;
}

function updateManifest(
    source: string,
    path: string,
    currentVersion: string,
    version: string,
): string {
    const manifest = parseManifest(source, path);
    if (manifest.version !== currentVersion) {
        throw new Error(
            `${path} version ${String(manifest.version)} does not match ${currentVersion}`,
        );
    }
    manifest.version = version;

    if (path.startsWith('extensions/')) {
        const expectedEngine = `^${currentVersion}`;
        if (manifest.engines?.caxri !== expectedEngine) {
            throw new Error(
                `${path} engines.caxri ${String(manifest.engines?.caxri)} does not match ${expectedEngine}`,
            );
        }
        manifest.engines.caxri = `^${version}`;
    }

    return `${JSON.stringify(manifest, undefined, 4)}\n`;
}

function updateVersionSource(
    source: string,
    path: string,
    constant: string,
    currentVersion: string,
    version: string,
): string {
    const currentDeclaration = `export const ${constant} = '${currentVersion}';`;
    const matches = source.split(currentDeclaration).length - 1;
    if (matches !== 1) {
        throw new Error(`${path} must contain exactly one ${constant} declaration for ${currentVersion}`);
    }
    return source.replace(
        currentDeclaration,
        () => `export const ${constant} = '${version}';`,
    );
}

async function writeAtomic(path: string, source: string): Promise<void> {
    const temporaryPath = `${path}.caxri-release-${process.pid}-${randomUUID()}`;
    try {
        await writeFile(temporaryPath, source, 'utf8');
        await rename(temporaryPath, path);
    } finally {
        await rm(temporaryPath, { force: true });
    }
}

/**
 * Restores every release source when any write fails so a version preparation never leaves a
 * partially bumped workspace.
 */
async function applyChanges(changes: FileChange[]): Promise<void> {
    const written: FileChange[] = [];
    try {
        for (const change of changes) {
            // eslint-disable-next-line no-await-in-loop -- sequential writes identify the exact prefix that rollback must restore
            await writeAtomic(change.path, change.nextSource);
            written.push(change);
        }
    } catch (error) {
        const restorations = await Promise.allSettled(
            written.map((change) => writeAtomic(change.path, change.originalSource)),
        );
        const restoreFailure = restorations.find((result) => result.status === 'rejected');
        if (restoreFailure) {
            throw new Error('Release preparation failed and could not restore every changed file', {
                cause: error,
            });
        }
        throw error;
    }
}

export async function assertReleaseSource(
    cwd: string,
    readGit: GitReader = defaultGitReader,
): Promise<void> {
    const root = resolve(cwd);
    const branch = await readGit(['branch', '--show-current'], root);
    if (branch !== 'main') throw new Error(`Release preparation requires main; current branch is ${branch}`);

    const status = await readGit(['status', '--porcelain', '--untracked-files=all'], root);
    if (status) throw new Error('Release preparation requires a clean worktree');

    const head = await readGit(['rev-parse', 'HEAD'], root);
    const upstream = await readGit(['rev-parse', '@{upstream}'], root);
    if (head !== upstream) throw new Error('Release preparation requires main to match its upstream');
}

export async function discoverReleaseManifestPaths(cwd: string): Promise<string[]> {
    const extensionEntries = await readdir(join(resolve(cwd), 'extensions'), {
        withFileTypes: true,
    });
    const extensionManifests = extensionEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => `extensions/${entry.name}/package.json`)
        .toSorted((left, right) => left.localeCompare(right));
    return [...PRODUCT_MANIFEST_PATHS, ...extensionManifests];
}

/**
 * Returns the exact file set written by `release:prepare`, which CI uses to keep its release fast-path fail-closed.
 */
export async function discoverReleaseSourcePaths(cwd: string): Promise<string[]> {
    return [
        ...(await discoverReleaseManifestPaths(cwd)),
        ...VERSION_SOURCES.map(({ path }) => path),
    ];
}

function hasExactPathSet(actual: readonly string[], expected: readonly string[]): boolean {
    const actualPaths = new Set(actual);
    const expectedPaths = new Set(expected);
    return (
        actual.length > 0 &&
        actualPaths.size === actual.length &&
        expectedPaths.size === expected.length &&
        actualPaths.size === expectedPaths.size &&
        expected.every((path) => actualPaths.has(path))
    );
}

/**
 * Verifies that the current commit contains exactly the source rewrite `release:prepare` would produce from its first
 * parent. A trusted title and allowed paths are not enough: dependency or script edits inside an allowed manifest must
 * fall back to normal main-push CI.
 */
export async function isExactReleasePreparationDelta(
    cwd: string,
    changedPaths: readonly string[],
    readPreviousSource: ReleaseSourceReader = defaultPreviousReleaseSourceReader,
): Promise<boolean> {
    const root = resolve(cwd);
    try {
        const manifestPaths = await discoverReleaseManifestPaths(root);
        const sourcePaths = [
            ...manifestPaths,
            ...VERSION_SOURCES.map(({ path }) => path),
        ];
        if (!hasExactPathSet(changedPaths, sourcePaths)) return false;

        const currentSources = new Map(
            await Promise.all(
                sourcePaths.map(async (path) => [
                    path,
                    await readFile(join(root, path), 'utf8'),
                ] as const),
            ),
        );
        const previousSources = new Map(
            await Promise.all(
                sourcePaths.map(async (path) => [
                    path,
                    await readPreviousSource(path, root),
                ] as const),
            ),
        );
        const currentVersion = parseManifest(
            currentSources.get(PRODUCT_MANIFEST_PATHS[0]) ?? '',
            PRODUCT_MANIFEST_PATHS[0],
        ).version;
        const previousVersion = parseManifest(
            previousSources.get(PRODUCT_MANIFEST_PATHS[0]) ?? '',
            PRODUCT_MANIFEST_PATHS[0],
        ).version;
        if (
            typeof currentVersion !== 'string' ||
            typeof previousVersion !== 'string' ||
            !gt(currentVersion, previousVersion)
        )
            return false;

        for (const path of manifestPaths) {
            const currentSource = currentSources.get(path);
            const previousSource = previousSources.get(path);
            if (
                currentSource === undefined ||
                previousSource === undefined ||
                currentSource !== updateManifest(previousSource, path, previousVersion, currentVersion)
            )
                return false;
        }
        for (const { constant, path } of VERSION_SOURCES) {
            const currentSource = currentSources.get(path);
            const previousSource = previousSources.get(path);
            if (
                currentSource === undefined ||
                previousSource === undefined ||
                currentSource !==
                    updateVersionSource(
                        previousSource,
                        path,
                        constant,
                        previousVersion,
                        currentVersion,
                    )
            )
                return false;
        }
        return true;
    } catch {
        return false;
    }
}

export async function prepareRelease(cwd: string, target: string): Promise<PreparedRelease> {
    const root = resolve(cwd);
    const manifestPaths = await discoverReleaseManifestPaths(root);
    const manifestSources = await Promise.all(
        manifestPaths.map(async (path) => ({
            originalSource: await readFile(join(root, path), 'utf8'),
            path,
        })),
    );
    const rootManifest = parseManifest(manifestSources[0].originalSource, PRODUCT_MANIFEST_PATHS[0]);
    if (typeof rootManifest.version !== 'string') throw new Error('package.json is missing version');
    const currentVersion = rootManifest.version;
    const version = nextVersion(currentVersion, target);

    const manifestChanges = manifestSources.map(({ originalSource, path }) => ({
        nextSource: updateManifest(originalSource, path, currentVersion, version),
        originalSource,
        path: join(root, path),
    }));
    const versionChanges = await Promise.all(
        VERSION_SOURCES.map(async ({ constant, path }) => {
            const originalSource = await readFile(join(root, path), 'utf8');
            return {
                nextSource: updateVersionSource(
                    originalSource,
                    path,
                    constant,
                    currentVersion,
                    version,
                ),
                originalSource,
                path: join(root, path),
            };
        }),
    );
    const changes = [...manifestChanges, ...versionChanges];
    await applyChanges(changes);

    return {
        changedPaths: changes.map((change) => change.path.slice(root.length + 1)),
        previousVersion: currentVersion,
        version,
    };
}

export async function runPrepareRelease(
    arguments_: string[],
    cwd = process.cwd(),
    readGit: GitReader = defaultGitReader,
): Promise<PreparedRelease> {
    if (arguments_.length !== 1) {
        throw new Error('Usage: bun run release:prepare -- <major|minor|patch|version>');
    }
    await assertReleaseSource(cwd, readGit);
    return prepareRelease(cwd, arguments_[0]);
}

if (import.meta.main) {
    try {
        const result = await runPrepareRelease(process.argv.slice(2));
        process.stdout.write(
            `Prepared v${result.version} from v${result.previousVersion} across ${result.changedPaths.length} files.\n`,
        );
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}

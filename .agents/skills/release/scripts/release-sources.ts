import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PRODUCT_MANIFEST_PATHS = [
    'package.json',
    'apps/cli/package.json',
    'apps/desktop/package.json',
    'apps/mobile/package.json',
    'apps/server/package.json',
    'packages/agent-skills/package.json',
    'packages/client/package.json',
    'packages/extension-api/package.json',
] as const;

export const VERSION_SOURCES = [
    { constant: 'CLI_VERSION', path: 'apps/cli/src/version.ts' },
    {
        constant: 'SKILL_BUNDLE_VERSION',
        path: 'packages/agent-skills/src/version.ts',
    },
] as const;

interface PackageManifest {
    engines?: { caxri?: string };
    version?: string;
}

interface ParsedSemVersion {
    major: bigint;
    minor: bigint;
    patch: bigint;
    prerelease: string[] | undefined;
}

export type ReleaseSourceReader = (path: string, cwd: string) => Promise<string>;

const strictSemVersion =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const defaultPreviousReleaseSourceReader: ReleaseSourceReader = async (path, cwd) => {
    const { stdout } = await execFileAsync('git', ['show', `HEAD^:${path}`], {
        cwd,
        encoding: 'utf8',
    });
    return stdout;
};

export function parseManifest(source: string, path: string): PackageManifest {
    try {
        return JSON.parse(source) as PackageManifest;
    } catch (error) {
        throw new Error(`${path} is not valid JSON`, { cause: error });
    }
}

function parseStrictSemVersion(version: string): ParsedSemVersion | undefined {
    const match = strictSemVersion.exec(version);
    if (!match) return undefined;
    return {
        major: BigInt(match[1]),
        minor: BigInt(match[2]),
        patch: BigInt(match[3]),
        prerelease: match[4]?.split('.'),
    };
}

function comparePrerelease(
    left: readonly string[] | undefined,
    right: readonly string[] | undefined,
): number {
    if (!left && !right) return 0;
    if (!left) return 1;
    if (!right) return -1;
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const leftIdentifier = left[index];
        if (leftIdentifier === undefined) return -1;
        const rightIdentifier = right[index];
        if (rightIdentifier === undefined) return 1;
        if (leftIdentifier === rightIdentifier) continue;

        const isLeftNumeric = /^\d+$/u.test(leftIdentifier);
        const isRightNumeric = /^\d+$/u.test(rightIdentifier);
        if (isLeftNumeric && isRightNumeric) {
            return BigInt(leftIdentifier) > BigInt(rightIdentifier) ? 1 : -1;
        }
        if (isLeftNumeric !== isRightNumeric) return isLeftNumeric ? -1 : 1;
        return leftIdentifier > rightIdentifier ? 1 : -1;
    }
    return 0;
}

export function isStrictlyNewerVersion(current: string, previous: string): boolean {
    const currentVersion = parseStrictSemVersion(current);
    const previousVersion = parseStrictSemVersion(previous);
    if (!currentVersion || !previousVersion) return false;
    for (const field of ['major', 'minor', 'patch'] as const) {
        if (currentVersion[field] === previousVersion[field]) continue;
        return currentVersion[field] > previousVersion[field];
    }
    return comparePrerelease(currentVersion.prerelease, previousVersion.prerelease) > 0;
}

export function updateManifest(
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

export function updateVersionSource(
    source: string,
    path: string,
    constant: string,
    currentVersion: string,
    version: string,
): string {
    const currentDeclaration = `export const ${constant} = '${currentVersion}';`;
    const matches = source.split(currentDeclaration).length - 1;
    if (matches !== 1) {
        throw new Error(
            `${path} must contain exactly one ${constant} declaration for ${currentVersion}`,
        );
    }
    return source.replace(currentDeclaration, () => `export const ${constant} = '${version}';`);
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
 * parent. This module intentionally uses only platform APIs because CI evaluates it before installing dependencies.
 */
export async function isExactReleasePreparationDelta(
    cwd: string,
    changedPaths: readonly string[],
    readPreviousSource: ReleaseSourceReader = defaultPreviousReleaseSourceReader,
): Promise<boolean> {
    const root = resolve(cwd);
    try {
        const manifestPaths = await discoverReleaseManifestPaths(root);
        const sourcePaths = [...manifestPaths, ...VERSION_SOURCES.map(({ path }) => path)];
        if (!hasExactPathSet(changedPaths, sourcePaths)) return false;

        const currentSources = new Map(
            await Promise.all(
                sourcePaths.map(
                    async (path) => [path, await readFile(join(root, path), 'utf8')] as const,
                ),
            ),
        );
        const previousSources = new Map(
            await Promise.all(
                sourcePaths.map(
                    async (path) => [path, await readPreviousSource(path, root)] as const,
                ),
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
            !isStrictlyNewerVersion(currentVersion, previousVersion)
        )
            return false;

        for (const path of manifestPaths) {
            const currentSource = currentSources.get(path);
            const previousSource = previousSources.get(path);
            if (
                currentSource === undefined ||
                previousSource === undefined ||
                currentSource !==
                    updateManifest(previousSource, path, previousVersion, currentVersion)
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

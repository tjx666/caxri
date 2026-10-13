import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';
import { gt, inc, valid } from 'semver';

import {
    discoverReleaseManifestPaths,
    parseManifest,
    PRODUCT_MANIFEST_PATHS,
    updateManifest,
    updateVersionSource,
    VERSION_SOURCES,
} from './release-sources';

export { discoverReleaseManifestPaths } from './release-sources';

type ReleaseIncrement = 'major' | 'minor' | 'patch';

interface FileChange {
    nextSource: string;
    originalSource: string;
    path: string;
}

export interface PreparedRelease {
    changedPaths: string[];
    previousVersion: string;
    version: string;
}

export type GitReader = (arguments_: string[], cwd: string) => Promise<string>;

const defaultGitReader: GitReader = async (arguments_, cwd) => {
    const { stdout } = await execFileAsync('git', arguments_, { cwd, encoding: 'utf8' });
    return stdout.trim();
};

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

/**
 * Requires a clean checkout whose HEAD is exactly the freshly fetched `origin/main`. The branch name is
 * deliberately unchecked: releases are prepared on a linked worktree's release branch, because the primary
 * checkout stays on `main` and Git cannot check `main` out twice.
 */
export async function assertReleaseSource(
    cwd: string,
    readGit: GitReader = defaultGitReader,
): Promise<void> {
    const root = resolve(cwd);
    const status = await readGit(['status', '--porcelain', '--untracked-files=all'], root);
    if (status) throw new Error('Release preparation requires a clean worktree');

    await readGit(['fetch', '--quiet', 'origin', 'main'], root);
    const head = await readGit(['rev-parse', 'HEAD'], root);
    const remoteMain = await readGit(['rev-parse', 'refs/remotes/origin/main'], root);
    if (head !== remoteMain) {
        throw new Error('Release preparation requires HEAD to match origin/main; run `git rebase origin/main` first');
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

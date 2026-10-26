import type { Buffer } from 'node:buffer';
import { lstat, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import { writeTextAtomic } from '../../../../scripts/atomic-json';
import { CommandError, runInherited } from './process';
import type { RepoContext } from './repo';
import { ensureProfile, errorCode, isPathPresent, withRepoLock, worktreeIdentity } from './repo';

/**
 * Whether a checkout has its own `node_modules`; a symlink shared from another checkout is refused.
 */
export type DependencyState = 'missing' | 'ready' | 'symlink';

async function restoreManifest(path: string, source: Buffer | undefined): Promise<void> {
    if (!source) {
        await rm(path, { force: true });
        return;
    }
    /**
     * The same-directory rename replaces a symlink entry instead of following it to another file.
     */
    await writeTextAtomic(path, source);
}

/**
 * Electron 42+ no longer declares a package lifecycle script, so dependency installation alone does not materialize its
 * binary. Repair only an incomplete install so worktree creation and development startup retain their ready-to-run
 * contracts without repeating a completed download.
 *
 * @see https://github.com/tjx666/caxri/issues/276
 */
export async function hasElectronBinaryArtifacts(path: string): Promise<boolean> {
    const electronDirectory = join(path, 'node_modules', 'electron');
    try {
        const executableRelativePath = (await readFile(join(electronDirectory, 'path.txt'), 'utf8'))
            .toString()
            .trim();
        const packageManifest = JSON.parse(
            await readFile(join(electronDirectory, 'package.json'), 'utf8'),
        ) as { version?: unknown };
        const installedVersion = (
            await readFile(join(electronDirectory, 'dist', 'version'), 'utf8')
        )
            .trim()
            .replace(/^v/, '');
        if (
            !executableRelativePath ||
            typeof packageManifest.version !== 'string' ||
            installedVersion !== packageManifest.version
        ) {
            return false;
        }
        const distributionDirectory = resolve(electronDirectory, 'dist');
        const executablePath = resolve(distributionDirectory, executableRelativePath);
        const executableWithinDistribution = relative(distributionDirectory, executablePath);
        if (
            !executableWithinDistribution ||
            executableWithinDistribution === '..' ||
            executableWithinDistribution.startsWith(`..${sep}`) ||
            isAbsolute(executableWithinDistribution)
        ) {
            return false;
        }
        return (await lstat(executablePath)).isFile();
    } catch (error) {
        if (errorCode(error) === 'ENOENT' || error instanceof SyntaxError) return false;
        throw error;
    }
}

export async function ensureElectronBinary(
    path: string,
    shouldPipeStdoutToStderr: boolean,
): Promise<void> {
    const electronDirectory = join(path, 'node_modules', 'electron');
    if (await hasElectronBinaryArtifacts(path)) return;

    const installScript = join(electronDirectory, 'install.js');
    if (!(await isPathPresent(installScript))) {
        throw new CommandError(`Electron installer is missing: ${installScript}`);
    }
    const exitCode = await runInherited('node', [installScript], {
        cwd: path,
        env: process.env,
        stdoutToStderr: shouldPipeStdoutToStderr,
    });
    if (exitCode !== 0) {
        throw new CommandError(`Electron binary installation failed with exit code ${exitCode}`);
    }
    if (!(await hasElectronBinaryArtifacts(path))) {
        throw new CommandError(
            `Electron binary installation left incomplete artifacts in ${electronDirectory}`,
        );
    }
}

/**
 * A fresh pnpm virtual store can preserve node-pty's macOS helper without its executable bit. Run the canonical
 * preparation script inside the target checkout so native tests and Server artifact staging work before any task uses
 * that worktree. Generic repository fixtures omit the script and do not need Caxri-specific native preparation.
 */
async function prepareNodePty(path: string, shouldPipeStdoutToStderr: boolean): Promise<void> {
    const script = join(path, 'scripts', 'prepare-node-pty.ts');
    if (!(await isPathPresent(script))) return;
    const exitCode = await runInherited('bun', ['run', 'scripts/prepare-node-pty.ts'], {
        cwd: path,
        env: process.env,
        stdoutToStderr: shouldPipeStdoutToStderr,
    });
    if (exitCode !== 0) {
        throw new CommandError(`node-pty preparation failed with exit code ${exitCode}`);
    }
}

export async function installWorktreeDependencies(
    path: string,
    shouldPipeStdoutToStderr = false,
): Promise<void> {
    const manifestNames = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'] as const;
    // Each manifest lives at an independent path, so reading them can run concurrently.
    const manifestEntries = await Promise.all(
        manifestNames.map(async (name): Promise<[string, Buffer | undefined]> => {
            const manifestPath = join(path, name);
            try {
                const stats = await lstat(manifestPath);
                if (stats.isSymbolicLink())
                    throw new CommandError(
                        `Refusing dependency install with symbolic link manifest: ${manifestPath}`,
                    );
                if (!stats.isFile())
                    throw new CommandError(
                        `Refusing dependency install with non-file manifest: ${manifestPath}`,
                    );
                return [name, await readFile(manifestPath)];
            } catch (error) {
                if (errorCode(error) !== 'ENOENT') throw error;
                return [name, undefined];
            }
        }),
    );
    const manifests = new Map<string, Buffer | undefined>(manifestEntries);
    let exitCode: number;
    try {
        exitCode = await runInherited('ni', [], {
            cwd: path,
            env: process.env,
            stdoutToStderr: shouldPipeStdoutToStderr,
        });
    } finally {
        /**
         * Dependency installs may rewrite lockfile metadata during a no-change install. A managed worktree must
         * preserve the caller's exact manifests, including existing edits. Each manifest restores to an independent
         * path, so this can also run concurrently.
         */
        await Promise.all(
            [...manifests].map(([name, source]) => restoreManifest(join(path, name), source)),
        );
    }
    if (exitCode !== 0) throw new CommandError(`ni failed with exit code ${exitCode}`);
    await prepareNodePty(path, shouldPipeStdoutToStderr);
    await ensureElectronBinary(path, shouldPipeStdoutToStderr);
}

export async function dependencyState(path: string): Promise<DependencyState> {
    try {
        const stats = await lstat(join(path, 'node_modules'));
        if (stats.isSymbolicLink()) return 'symlink';
        return stats.isDirectory() ? 'ready' : 'missing';
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return 'missing';
        throw error;
    }
}

/**
 * Records the worktree identity and isolated profile. Runs under the repository lock because both are shared metadata.
 */
export async function prepareManagedWorktree(context: RepoContext, path: string): Promise<string> {
    const identity = await worktreeIdentity(path, true);
    if (!identity) throw new CommandError(`Could not create an identity for ${path}`);
    await ensureProfile(context, identity);
    if ((await dependencyState(path)) === 'symlink') {
        throw new CommandError(`Refusing shared node_modules symlink in ${path}`);
    }
    return identity;
}

/**
 * Serializes work on one worktree's `node_modules`. `ni` takes tens of seconds, so this lock waits up to 15 minutes
 * instead of the repository lock's 10 seconds: a second session resolving the same branch, or a `dev` start, waits for
 * the running install instead of failing or writing Electron artifacts concurrently.
 */
export function withInstallLock<T>(
    context: RepoContext,
    identity: string,
    task: () => Promise<T>,
): Promise<T> {
    return withRepoLock(context, task, {
        namespace: `install-${identity}`,
        timeoutMs: 15 * 60_000,
    });
}

/**
 * Installs dependencies outside the repository lock. Every other switch-worktree operation (including the desktop lease
 * release that ends an E2E run) waits at most 10 seconds for that lock, so holding it across `ni` made a sibling
 * session's command fail.
 */
export async function installManagedWorktree(
    context: RepoContext,
    path: string,
    identity: string,
    install: (path: string) => Promise<void>,
): Promise<void> {
    await withInstallLock(context, identity, async () => {
        const dependencies = await dependencyState(path);
        if (dependencies === 'symlink') {
            throw new CommandError(`Refusing shared node_modules symlink in ${path}`);
        }
        if (dependencies === 'ready' && (await hasElectronBinaryArtifacts(path))) return;
        await install(path);
        if ((await dependencyState(path)) !== 'ready')
            throw new CommandError(`ni did not create ${path}/node_modules`);
        if (!(await hasElectronBinaryArtifacts(path)))
            throw new CommandError(`ni left incomplete Electron artifacts in ${path}/node_modules`);
    });
}

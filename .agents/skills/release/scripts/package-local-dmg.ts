import type { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { execFileAsync } from '@caxri/system';

import { writeTextAtomic } from '../../../../scripts/atomic-json';

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const RELEASE_OUTPUT_DIRECTORY = 'release.noindex';
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Z.-]+)?$/i;

export interface CommandResult {
    exitCode: number;
    stderr: string;
    stdout: string;
}

export interface CommandExecutor {
    run(
        command: string,
        arguments_: string[],
        options: { capture: boolean; cwd: string },
    ): Promise<CommandResult>;
}

export interface LocalDmgOptions {
    allowDirty: boolean;
    cwd: string;
    version: string;
}

interface CliOptions extends LocalDmgOptions {
    help: boolean;
}

interface ProcessFailure extends Error {
    code?: number | string;
    stderr?: Buffer | string;
    stdout?: Buffer | string;
}

const defaultExecutor: CommandExecutor = {
    async run(command, arguments_, options) {
        if (!options.capture) {
            const child = spawn(command, arguments_, { cwd: options.cwd, stdio: 'inherit' });
            const exitCode = await new Promise<number>((resolve, reject) => {
                child.once('error', reject);
                child.once('exit', (code, signal) => {
                    if (signal) reject(new Error(`${command} exited with ${signal}`));
                    else resolve(code ?? 1);
                });
            });
            return { exitCode, stderr: '', stdout: '' };
        }
        try {
            const { stderr, stdout } = await execFileAsync(command, arguments_, {
                cwd: options.cwd,
                encoding: 'utf8',
                maxBuffer: MAX_CAPTURE_BYTES,
            });
            return { exitCode: 0, stderr, stdout };
        } catch (error) {
            const failure = error as ProcessFailure;
            return {
                exitCode: typeof failure.code === 'number' ? failure.code : 1,
                stderr: failure.stderr?.toString() ?? '',
                stdout: failure.stdout?.toString() ?? '',
            };
        }
    },
};

function assertVersion(value: string): string {
    if (!VERSION_PATTERN.test(value)) throw new Error('--version must be a valid SemVer version');
    return value;
}

/**
 * Applies a single CLI argument to `options` and reports how many extra `arguments_` entries it consumed (e.g.
 * `--version <semver>`). Extracted out of the parsing loop so the `switch` cases can `return` instead of nesting
 * `break` inside a loop.
 */
function applyLocalDmgArgument(
    argument: string,
    nextArgument: string | undefined,
    options: CliOptions,
): number {
    switch (argument) {
        case '--help':
        case '-h':
            options.help = true;
            return 0;
        case '--allow-dirty':
            options.allowDirty = true;
            return 0;
        case '--version':
            options.version = assertVersion(nextArgument ?? '');
            return 1;
        default:
            throw new Error(`Unknown option: ${argument}`);
    }
}

export function parseLocalDmgArguments(arguments_: string[], cwd = process.cwd()): CliOptions {
    const options: CliOptions = { allowDirty: false, cwd, help: false, version: '' };
    for (let index = 0; index < arguments_.length; index += 1) {
        index += applyLocalDmgArgument(arguments_[index], arguments_[index + 1], options);
    }
    if (!options.help && !options.version) throw new Error('Missing --version');
    return options;
}

function commandFailure(command: string, result: CommandResult): Error {
    const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    return new Error(detail || `${command} exited with code ${result.exitCode}`);
}

async function runRequired(
    executor: CommandExecutor,
    command: string,
    arguments_: string[],
    cwd: string,
    shouldCaptureOutput = true,
): Promise<CommandResult> {
    const result = await executor.run(command, arguments_, { capture: shouldCaptureOutput, cwd });
    if (result.exitCode !== 0) throw commandFailure(`${command} ${arguments_.join(' ')}`, result);
    return result;
}

function packageVersion(source: string, label: string): string {
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch (error) {
        throw new Error(
            `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
        );
    }
    const version = (value as { version?: unknown }).version;
    if (typeof version !== 'string') throw new Error(`${label} is missing version`);
    return version;
}

async function sha256(path: string): Promise<string> {
    return createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
}

async function restoreFileAtomic(path: string, source: string): Promise<void> {
    await writeTextAtomic(path, source);
}

function signingField(source: string, name: string): string | null {
    const match = source.match(new RegExp(`^${name}=(.+)$`, 'm'));
    return match?.[1]?.trim() ?? null;
}

/**
 * Temporarily updates pnpm-owned version metadata and restores the exact original bytes.
 */
async function buildVersionedDmg(
    options: LocalDmgOptions,
    executor: CommandExecutor,
): Promise<{ buildStartedAt: number; originalVersion: string }> {
    const cwd = resolve(options.cwd);
    const packagePath = join(cwd, 'package.json');
    const lockPath = join(cwd, 'pnpm-lock.yaml');
    const [packageSource, lockSource] = await Promise.all([
        readFile(packagePath, 'utf8'),
        readFile(lockPath, 'utf8'),
    ]);
    const originalVersion = packageVersion(packageSource, 'package.json');
    const manifestStatus = await runRequired(
        executor,
        'git',
        ['status', '--short', '--', 'package.json', 'pnpm-lock.yaml'],
        cwd,
    );
    if (manifestStatus.stdout.trim()) {
        throw new Error('Refusing to package with modified package.json or pnpm-lock.yaml');
    }
    const worktreeStatus = await runRequired(
        executor,
        'git',
        ['status', '--short', '--untracked-files=all'],
        cwd,
    );
    if (!options.allowDirty && worktreeStatus.stdout.trim()) {
        throw new Error('Refusing to package a dirty worktree; pass --allow-dirty explicitly');
    }

    let buildError: unknown;
    let buildStartedAt = 0;
    let interruptedSignal: NodeJS.Signals | undefined;
    let restoreError: Error | undefined;
    let isVersionChanged = false;
    /**
     * Keep the parent alive long enough to restore manifests when an interactive build is stopped.
     */
    const onInterrupt = (): void => {
        interruptedSignal = 'SIGINT';
    };
    const onTerminate = (): void => {
        interruptedSignal = 'SIGTERM';
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    try {
        if (originalVersion !== options.version) {
            isVersionChanged = true;
            await runRequired(
                executor,
                'pnpm',
                ['version', options.version, '--no-git-tag-version', '--no-git-checks'],
                cwd,
            );
            const versionedPackage = await readFile(packagePath, 'utf8');
            if (packageVersion(versionedPackage, 'package.json') !== options.version) {
                throw new Error('pnpm did not apply the requested package version');
            }
        }
        buildStartedAt = Date.now();
        await runRequired(executor, 'bun', ['run', 'package:dmg'], cwd, false);
    } catch (error) {
        buildError = error;
    } finally {
        if (isVersionChanged) {
            try {
                await Promise.all([
                    restoreFileAtomic(packagePath, packageSource),
                    restoreFileAtomic(lockPath, lockSource),
                ]);
                const [restoredPackage, restoredLock] = await Promise.all([
                    readFile(packagePath, 'utf8'),
                    readFile(lockPath, 'utf8'),
                ]);
                if (restoredPackage !== packageSource || restoredLock !== lockSource) {
                    restoreError = new Error(
                        'Failed to restore package manifests after local packaging',
                    );
                }
            } catch (error) {
                restoreError = new Error(
                    'Failed to restore package manifests after local packaging',
                    {
                        cause: error,
                    },
                );
            }
        }
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onTerminate);
    }
    if (restoreError) throw restoreError;
    if (interruptedSignal && !buildError) {
        buildError = new Error(`Local DMG packaging interrupted by ${interruptedSignal}`);
    }
    if (buildError) {
        throw buildError instanceof Error
            ? buildError
            : new Error('Local DMG packaging failed with a non-Error value', {
                  cause: buildError,
              });
    }
    return { buildStartedAt, originalVersion };
}

export async function packageLocalDmg(
    options: LocalDmgOptions,
    executor: CommandExecutor = defaultExecutor,
    verifiedAt = new Date().toISOString(),
) {
    const version = assertVersion(options.version);
    const cwd = resolve(options.cwd);
    const { buildStartedAt, originalVersion } = await buildVersionedDmg(
        { ...options, cwd, version },
        executor,
    );
    const artifactPath = join(cwd, RELEASE_OUTPUT_DIRECTORY, `Caxri-${version}-arm64.dmg`);
    const appPath = join(cwd, RELEASE_OUTPUT_DIRECTORY, 'mac-arm64', 'Caxri.app');
    const executablePath = join(appPath, 'Contents', 'MacOS', 'Caxri');
    const infoPath = join(appPath, 'Contents', 'Info.plist');
    const artifact = await stat(artifactPath);
    if (artifact.mtimeMs + 1_000 < buildStartedAt) {
        throw new Error(`Packaged artifact is stale: ${artifactPath}`);
    }

    await runRequired(executor, 'hdiutil', ['verify', artifactPath], cwd);
    const [bundleVersion, architectures, fileType, signing] = await Promise.all([
        runRequired(
            executor,
            'plutil',
            ['-extract', 'CFBundleShortVersionString', 'raw', infoPath],
            cwd,
        ),
        runRequired(executor, 'lipo', ['-archs', executablePath], cwd),
        runRequired(executor, 'file', [artifactPath], cwd),
        executor.run('codesign', ['-dv', '--verbose=4', appPath], { capture: true, cwd }),
    ]);
    if (bundleVersion.stdout.trim() !== version) {
        throw new Error(
            `Packaged version mismatch: expected ${version}, got ${bundleVersion.stdout.trim()}`,
        );
    }
    const arch = architectures.stdout.trim().split(/\s+/).filter(Boolean);
    if (!arch.includes('arm64')) throw new Error(`Packaged app is not arm64: ${arch.join(' ')}`);
    const strictCodeSign = await executor.run(
        'codesign',
        ['--verify', '--deep', '--strict', appPath],
        { capture: true, cwd },
    );
    const signingDescription = `${signing.stdout}\n${signing.stderr}`;

    return {
        architecture: arch,
        artifactPath,
        bytes: artifact.size,
        codeSigning: {
            inspectionPassed: signing.exitCode === 0,
            signature: signingField(signingDescription, 'Signature'),
            strictVerificationDetail:
                [strictCodeSign.stdout.trim(), strictCodeSign.stderr.trim()]
                    .filter(Boolean)
                    .join('\n') || null,
            strictVerificationPassed: strictCodeSign.exitCode === 0,
            teamIdentifier: signingField(signingDescription, 'TeamIdentifier'),
        },
        fileType: fileType.stdout.trim(),
        originalSourceVersion: originalVersion,
        sha256: await sha256(artifactPath),
        source: {
            dirtyAllowed: options.allowDirty,
            headSha: (await runRequired(executor, 'git', ['rev-parse', 'HEAD'], cwd)).stdout.trim(),
        },
        verifiedAt,
        version,
    };
}

function help(): string {
    return `Build and verify a local Caxri DMG

Usage:
  bun run .agents/skills/release/scripts/package-local-dmg.ts --version <semver>

Options:
  --version VERSION  Version embedded in the local arm64 DMG
  --allow-dirty      Package the current dirty source tree explicitly
  --help             Show this help

The script restores package.json and pnpm-lock.yaml after success or failure.
It never creates a commit, tag, GitHub Release, or upload.`;
}

async function main(arguments_: string[]): Promise<void> {
    const options = parseLocalDmgArguments(arguments_);
    if (options.help) {
        console.log(help());
        return;
    }
    console.log(JSON.stringify(await packageLocalDmg(options), null, 2));
}

const SCRIPT_PATH = resolve(fileURLToPath(import.meta.url));
const invokedPath =
    process.argv[1] && (isAbsolute(process.argv[1]) ? process.argv[1] : resolve(process.argv[1]));
if (invokedPath === SCRIPT_PATH) {
    try {
        await main(process.argv.slice(2));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

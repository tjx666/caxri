import { constants } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';

import type { LowCostSandboxFailureReason } from '@caxri/protocol';
import { CaxriError, isCaxriError, lowCostSandboxFailureReasonSchema } from '@caxri/protocol';
import { isAccessible } from '@caxri/system';

import { isOutsideRoot } from '../path-security';

const MACOS_SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec';
/**
 * Distribution packages install bubblewrap here; Ubuntu's AppArmor policy only grants unprivileged user namespaces to
 * this packaged path, so a copy elsewhere on `PATH` is deliberately not searched.
 */
const LINUX_SANDBOX_EXECUTABLES = ['/usr/bin/bwrap', '/bin/bwrap'] as const;

/**
 * The host sandbox wrapper: run `executable` with `arguments` prepended to the provider's own argv.
 */
export interface LowCostSandboxLaunch {
    arguments: readonly string[];
    executable: string;
}

export function lowCostSandboxFailureReason(
    error: unknown,
): LowCostSandboxFailureReason | undefined {
    if (!isCaxriError(error)) return undefined;
    const reason = error.details?.reason;
    const parsed = lowCostSandboxFailureReasonSchema.safeParse(reason);
    return parsed.success ? parsed.data : undefined;
}

/**
 * Resolve existing ancestors too: an absent provider home beneath /tmp must still compare against /private/tmp.
 */
async function canonicalOptionalDirectory(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path)
            throw error;
        return join(await canonicalOptionalDirectory(dirname(path)), basename(path));
    }
}

/**
 * Sandbox-exec also checks symlink entries while traversing a runtime path, before reaching its target.
 */
async function runtimeEntries(path: string): Promise<string[]> {
    const entries: string[] = [];
    for (let entry = resolve(path); dirname(entry) !== entry; entry = dirname(entry))
        entries.push(entry);
    return Promise.all(
        entries.map(async (entry) =>
            join(await canonicalOptionalDirectory(dirname(entry)), basename(entry)),
        ),
    );
}

/**
 * Verify the whole deny boundary before launching a provider, without granting exceptions inside the Project.
 */
export async function prepareLowCostSandbox(options: {
    projectDirectory: string;
    configDirectory: string;
    executable: string;
    isolatedDirectory: string;
    instructionNames: readonly string[];
    platform?: NodeJS.Platform;
}): Promise<LowCostSandboxLaunch> {
    const platform = options.platform ?? process.platform;
    const linuxSandbox = platform === 'linux' ? await linuxSandboxExecutable() : undefined;
    if (platform !== 'darwin' && !linuxSandbox)
        throw new CaxriError(
            'UNAVAILABLE',
            'Low-cost generation needs bubblewrap (bwrap) on this machine.',
            { reason: 'sandboxUnavailable' },
        );
    try {
        const [project, config, executable, isolated] = await Promise.all([
            realpath(options.projectDirectory),
            canonicalOptionalDirectory(resolve(options.configDirectory)),
            realpath(options.executable),
            realpath(options.isolatedDirectory),
        ]);
        const entryPaths = await Promise.all(
            [options.configDirectory, options.executable, options.isolatedDirectory].map(
                runtimeEntries,
            ),
        );
        if (
            [config, executable, isolated, ...entryPaths.flat()].some(
                (path) => !isOutsideRoot(relative(project, path)),
            )
        )
            throw new CaxriError(
                'UNAVAILABLE',
                'Low-cost generation cannot access its runtime outside this Project boundary. Choose a more specific Project folder.',
                { reason: 'sandboxBoundaryConflict' },
            );
        const entries = await Promise.all(
            options.instructionNames.map(async (name) => {
                const entry = join(config, name);
                try {
                    return { paths: [entry, await realpath(entry)], exists: true };
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    return { paths: [entry], exists: false };
                }
            }),
        );
        if (linuxSandbox)
            return {
                executable: linuxSandbox,
                arguments: bubblewrapArguments({
                    // A bind mount needs an existing target, and an absent file has nothing to read anyway.
                    literals: [
                        ...new Set(
                            entries.filter((entry) => entry.exists).flatMap((entry) => entry.paths),
                        ),
                    ],
                    subpaths: [project],
                }),
            };
        return {
            executable: MACOS_SANDBOX_EXECUTABLE,
            arguments: [
                '-p',
                lowCostSandboxProfile({
                    literals: [...new Set(entries.flatMap((entry) => entry.paths))],
                    subpaths: [project],
                }),
            ],
        };
    } catch (error) {
        if (lowCostSandboxFailureReason(error)) throw error;
        // Native path errors can expose provider configuration paths; retain only the closed failure reason.
        throw new CaxriError('UNAVAILABLE', 'Unable to verify the low-cost generation sandbox.', {
            reason: 'sandboxPathUnavailable',
        });
    }
}

interface LowCostSandboxDenials {
    /**
     * Absolute file paths denied exactly, for instruction files an Agent CLI cannot be told to skip.
     */
    literals: readonly string[];
    /**
     * Absolute directory roots denied recursively, normally the Project the Session is attached to.
     */
    subpaths: readonly string[];
}

/**
 * Builds the macOS sandbox profile that wraps a low-cost text generation.
 *
 * Paste summaries are bounded text transformations, so an Agent CLI must not silently widen them by loading Project or
 * global instruction files. Every provider offers switches for some of those inputs and none for all of them, so the
 * host sandbox is the only place the guarantee can be made uniformly. The profile stays permissive by default so
 * provider authentication, model network access, and the provider's own state directory keep working; only the named
 * reads are removed. The denial is by path, not by purpose: a Project rooted at an ancestor of the provider's state
 * directory or of the CLI's runtime (a home directory added as a Project) makes every generation fail; the paste flow
 * then falls back to the unsummarized paste.
 *
 * Deny both instruction entries and their resolved targets. The entry denial protects reads through a link; the target
 * denial also protects direct reads of that file. The caller canonicalizes directory roots before this boundary.
 */
function lowCostSandboxProfile(denials: LowCostSandboxDenials): string {
    return [
        '(version 1)',
        '(allow default)',
        ...denials.subpaths.map((path) => `(deny file-read* (subpath ${JSON.stringify(path)}))`),
        ...denials.literals.map((path) => `(deny file-read* (literal ${JSON.stringify(path)}))`),
    ].join(' ');
}

async function linuxSandboxExecutable(): Promise<string | undefined> {
    for (const candidate of LINUX_SANDBOX_EXECUTABLES) {
        // Ordered probe: the first installed path wins.
        // eslint-disable-next-line no-await-in-loop -- ordered probe, see comment above
        if (await isAccessible(candidate, constants.X_OK)) return candidate;
    }
    return undefined;
}

/**
 * The Linux equivalent of {@link lowCostSandboxProfile}: keep the host filesystem as-is, hide each denied directory
 * behind an empty tmpfs, and replace each denied file with `/dev/null`. `--die-with-parent` ties the sandbox to the
 * Server so a timed-out generation cannot outlive it.
 */
function bubblewrapArguments(denials: LowCostSandboxDenials): string[] {
    return [
        '--dev-bind',
        '/',
        '/',
        ...denials.subpaths.flatMap((path) => ['--tmpfs', path]),
        ...denials.literals.flatMap((path) => ['--ro-bind', '/dev/null', path]),
        '--die-with-parent',
        '--',
    ];
}

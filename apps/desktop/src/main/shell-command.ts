import { lstat, readlink, symlink, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ShellCommandResult } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';

/**
 * `/usr/local/bin` is listed in macOS's default `/etc/paths`, so a link there reaches every login shell without editing
 * shell startup files. This matches VS Code's `Install 'code' command in PATH`.
 */
export const SHELL_COMMAND_LINK_PATH = '/usr/local/bin/caxri';

/**
 * Every packaged Caxri variant (`Caxri.app`, `Caxri Dev.app`, a renamed copy starting with "Caxri") ships its launcher
 * at this bundle-relative location (see `build/caxri`). Uninstall only removes a link aimed at such a launcher, so it
 * never deletes an unrelated `caxri` someone else put on `PATH`.
 */
const BUNDLE_LAUNCHER_PATTERN = /\/Caxri[^/]*\.app\/Contents\/Resources\/bin\/caxri$/;

type ShellCommandAction = 'install' | 'uninstall';

export type ElevationOutcome = 'completed' | 'canceled';

export interface ShellCommandEnvironment {
    /**
     * The packaged launcher to link to; `undefined` for an unpackaged launch, which has no self-contained launcher.
     */
    launcherPath: string | undefined;
    linkPath: string;
    /**
     * Explains the upcoming administrator prompt; resolves `false` when the user declines.
     */
    confirmElevation(action: ShellCommandAction): Promise<boolean>;
    /**
     * Runs a `/bin/sh` command with administrator privileges.
     */
    runElevated(command: string): Promise<ElevationOutcome>;
}

function errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

/**
 * Permission failures and a missing `/usr/local/bin` both need root; any other error is a real failure to report.
 */
const ELEVATION_ERROR_CODES = new Set(['EACCES', 'EPERM', 'ENOENT']);

function requiresElevation(error: unknown): boolean {
    const code = errorCode(error);
    return code !== undefined && ELEVATION_ERROR_CODES.has(code);
}

type LinkState = { kind: 'missing' } | { kind: 'link'; target: string } | { kind: 'other' };

async function readLinkState(linkPath: string): Promise<LinkState> {
    try {
        const stats = await lstat(linkPath);
        if (!stats.isSymbolicLink()) return { kind: 'other' };
        return { kind: 'link', target: await readlink(linkPath) };
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return { kind: 'missing' };
        throw error;
    }
}

/**
 * POSIX single-quote quoting: the only character that needs care inside single quotes is the quote itself.
 */
export function quoteShellArgument(value: string): string {
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * Builds the AppleScript for `osascript`. The shell command travels as an AppleScript string literal, where only the
 * backslash and double quote are special; paths inside it are already single-quoted for `/bin/sh`.
 */
export function elevatedAppleScript(command: string): string {
    const literal = command.replaceAll('\\', '\\\\').replaceAll('"', String.raw`\"`);
    return `do shell script "${literal}" with administrator privileges`;
}

/**
 * Runs the command through the standard macOS authorization prompt. osascript reports a dismissed prompt as error -128
 * ("User canceled."), which is a choice rather than a failure.
 */
export async function runAsAdministrator(command: string): Promise<ElevationOutcome> {
    try {
        await execFileAsync('/usr/bin/osascript', ['-e', elevatedAppleScript(command)]);
        return 'completed';
    } catch (error) {
        const stderr =
            typeof error === 'object' && error !== null && 'stderr' in error
                ? String(Reflect.get(error, 'stderr'))
                : '';
        if (stderr.includes('(-128)')) return 'canceled';
        throw error;
    }
}

function conflict(message: string): CaxriError {
    return new CaxriError('CONFLICT', message);
}

export async function installShellCommand(
    environment: ShellCommandEnvironment,
): Promise<ShellCommandResult> {
    const { launcherPath, linkPath } = environment;
    if (!launcherPath)
        throw new CaxriError(
            'UNAVAILABLE',
            "The 'caxri' shell command can only be installed from the packaged Caxri app.",
        );
    const state = await readLinkState(linkPath);
    if (state.kind === 'other')
        throw conflict(
            `${linkPath} already exists and is not a symbolic link. Remove it, then install again.`,
        );
    if (state.kind === 'link' && state.target === launcherPath)
        return { status: 'alreadyInstalled', linkPath };
    try {
        // A link to another bundle (an older copy, a sibling variant) is replaced, the same as VS Code does.
        if (state.kind === 'link') await unlink(linkPath);
        await symlink(launcherPath, linkPath);
    } catch (error) {
        if (!requiresElevation(error)) throw error;
        if (!(await environment.confirmElevation('install')))
            return { status: 'canceled', linkPath };
        const command = `mkdir -p ${quoteShellArgument(dirname(linkPath))} && ln -sfh ${quoteShellArgument(launcherPath)} ${quoteShellArgument(linkPath)}`;
        if ((await environment.runElevated(command)) === 'canceled')
            return { status: 'canceled', linkPath };
        const installed = await readLinkState(linkPath);
        if (installed.kind !== 'link' || installed.target !== launcherPath)
            throw new CaxriError('INTERNAL', `Failed to create ${linkPath}.`);
    }
    return { status: 'installed', linkPath };
}

export async function uninstallShellCommand(
    environment: ShellCommandEnvironment,
): Promise<ShellCommandResult> {
    const { linkPath } = environment;
    const state = await readLinkState(linkPath);
    if (state.kind === 'missing') return { status: 'notInstalled', linkPath };
    if (state.kind === 'other')
        throw conflict(
            `${linkPath} is not a symbolic link created by Caxri; it was left in place.`,
        );
    if (!BUNDLE_LAUNCHER_PATTERN.test(state.target))
        throw conflict(
            `${linkPath} points to ${state.target}, which is not a Caxri app; it was left in place.`,
        );
    try {
        await unlink(linkPath);
    } catch (error) {
        if (!requiresElevation(error)) throw error;
        if (!(await environment.confirmElevation('uninstall')))
            return { status: 'canceled', linkPath };
        if ((await environment.runElevated(`rm -f ${quoteShellArgument(linkPath)}`)) === 'canceled')
            return { status: 'canceled', linkPath };
        if ((await readLinkState(linkPath)).kind !== 'missing')
            throw new CaxriError('INTERNAL', `Failed to remove ${linkPath}.`);
    }
    return { status: 'uninstalled', linkPath };
}

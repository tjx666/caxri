import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ShellCommandEnvironment } from '../shell-command';
import {
    elevatedAppleScript,
    installShellCommand,
    quoteShellArgument,
    runAsAdministrator,
    uninstallShellCommand,
} from '../shell-command';

const execFileAsync = vi.hoisted(() => vi.fn());
vi.mock('@caxri/system', () => ({ execFileAsync }));

/**
 * Per-test temp layout; a mutable object rather than reassigned module bindings.
 */
const paths = { root: '', linkPath: '', launcherPath: '' };

beforeEach(async () => {
    paths.root = await mkdtemp(join(tmpdir(), 'caxri-shell-command-'));
    paths.linkPath = join(paths.root, 'bin', 'caxri');
    paths.launcherPath = join(paths.root, 'Caxri.app', 'Contents', 'Resources', 'bin', 'caxri');
    await mkdir(join(paths.root, 'bin'));
});

afterEach(async () => {
    await rm(paths.root, { force: true, recursive: true });
});

function environment(overrides: Partial<ShellCommandEnvironment> = {}): ShellCommandEnvironment {
    return {
        launcherPath: paths.launcherPath,
        linkPath: paths.linkPath,
        confirmElevation: () => Promise.resolve(true),
        runElevated: () => Promise.reject(new Error('unexpected elevation')),
        ...overrides,
    };
}

describe('installShellCommand', () => {
    it('links the bundled launcher without elevation when the directory is writable', async () => {
        const confirmElevation = vi.fn(() => Promise.resolve(true));
        await expect(installShellCommand(environment({ confirmElevation }))).resolves.toEqual({
            status: 'installed',
            linkPath: paths.linkPath,
        });
        expect(await readlink(paths.linkPath)).toBe(paths.launcherPath);
        expect(confirmElevation).not.toHaveBeenCalled();
    });

    it('is idempotent once the link already targets this launcher', async () => {
        await symlink(paths.launcherPath, paths.linkPath);
        await expect(installShellCommand(environment())).resolves.toEqual({
            status: 'alreadyInstalled',
            linkPath: paths.linkPath,
        });
    });

    it('replaces a link to another bundle', async () => {
        await symlink('/Applications/Old Caxri.app/Contents/Resources/bin/caxri', paths.linkPath);
        await expect(installShellCommand(environment())).resolves.toMatchObject({
            status: 'installed',
        });
        expect(await readlink(paths.linkPath)).toBe(paths.launcherPath);
    });

    it('refuses to overwrite a regular file', async () => {
        await writeFile(paths.linkPath, '#!/bin/sh\n');
        await expect(installShellCommand(environment())).rejects.toMatchObject({
            code: 'CONFLICT',
        });
    });

    it('is unavailable without a packaged launcher', async () => {
        await expect(
            installShellCommand(environment({ launcherPath: undefined })),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    });

    it('elevates when the link directory is missing and verifies the result', async () => {
        const missingLinkPath = join(paths.root, 'missing', 'caxri');
        const runElevated = vi.fn(async () => {
            await mkdir(join(paths.root, 'missing'));
            await symlink(paths.launcherPath, missingLinkPath);
            return 'completed' as const;
        });
        const confirmElevation = vi.fn(() => Promise.resolve(true));
        await expect(
            installShellCommand(
                environment({ confirmElevation, linkPath: missingLinkPath, runElevated }),
            ),
        ).resolves.toEqual({ status: 'installed', linkPath: missingLinkPath });
        expect(confirmElevation).toHaveBeenCalledWith('install');
        expect(runElevated).toHaveBeenCalledWith(
            `mkdir -p ${quoteShellArgument(join(paths.root, 'missing'))} && ln -sfh ${quoteShellArgument(paths.launcherPath)} ${quoteShellArgument(missingLinkPath)}`,
        );
    });

    it('reports cancellation from either the explanation or the administrator prompt', async () => {
        const missingLinkPath = join(paths.root, 'missing', 'caxri');
        await expect(
            installShellCommand(
                environment({
                    linkPath: missingLinkPath,
                    confirmElevation: () => Promise.resolve(false),
                }),
            ),
        ).resolves.toMatchObject({ status: 'canceled' });
        await expect(
            installShellCommand(
                environment({
                    linkPath: missingLinkPath,
                    runElevated: () => Promise.resolve('canceled' as const),
                }),
            ),
        ).resolves.toMatchObject({ status: 'canceled' });
    });

    it('fails when the elevated command did not produce the link', async () => {
        const environment_ = environment({
            linkPath: join(paths.root, 'missing', 'caxri'),
            runElevated: () => Promise.resolve('completed' as const),
        });
        await expect(installShellCommand(environment_)).rejects.toMatchObject({ code: 'INTERNAL' });
    });
});

describe('uninstallShellCommand', () => {
    it('removes a link into a Caxri bundle', async () => {
        await symlink(paths.launcherPath, paths.linkPath);
        await expect(uninstallShellCommand(environment())).resolves.toEqual({
            status: 'uninstalled',
            linkPath: paths.linkPath,
        });
        await expect(readlink(paths.linkPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('works from an unpackaged launch', async () => {
        await symlink(paths.launcherPath, paths.linkPath);
        await expect(
            uninstallShellCommand(environment({ launcherPath: undefined })),
        ).resolves.toMatchObject({ status: 'uninstalled' });
    });

    it('reports a missing link without failing', async () => {
        await expect(uninstallShellCommand(environment())).resolves.toEqual({
            status: 'notInstalled',
            linkPath: paths.linkPath,
        });
    });

    it('leaves a foreign link and a regular file in place', async () => {
        await symlink('/Applications/Other.app/Contents/Resources/bin/caxri', paths.linkPath);
        await expect(uninstallShellCommand(environment())).rejects.toMatchObject({
            code: 'CONFLICT',
        });

        await rm(paths.linkPath);
        await symlink('/opt/homebrew/bin/caxri', paths.linkPath);
        await expect(uninstallShellCommand(environment())).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        expect(await readlink(paths.linkPath)).toBe('/opt/homebrew/bin/caxri');

        await rm(paths.linkPath);
        await writeFile(paths.linkPath, '#!/bin/sh\n');
        await expect(uninstallShellCommand(environment())).rejects.toMatchObject({
            code: 'CONFLICT',
        });
    });
});

describe('elevated command quoting', () => {
    it('keeps quotes and backslashes in paths literal through sh and AppleScript', () => {
        expect(quoteShellArgument(String.raw`/Apps/It's "Caxri"\.app`)).toBe(
            String.raw`'/Apps/It'\''s "Caxri"\.app'`,
        );
        expect(elevatedAppleScript(String.raw`rm -f '/a "b"\c'`)).toBe(
            String.raw`do shell script "rm -f '/a \"b\"\\c'" with administrator privileges`,
        );
    });
});

describe('runAsAdministrator', () => {
    it('runs osascript with an argv array and treats error -128 as a cancellation', async () => {
        execFileAsync.mockResolvedValueOnce({ stderr: '', stdout: '' });
        await expect(runAsAdministrator("rm -f '/x'")).resolves.toBe('completed');
        expect(execFileAsync).toHaveBeenLastCalledWith('/usr/bin/osascript', [
            '-e',
            elevatedAppleScript("rm -f '/x'"),
        ]);

        execFileAsync.mockRejectedValueOnce(
            Object.assign(new Error('failed'), {
                stderr: 'execution error: User canceled. (-128)',
            }),
        );
        await expect(runAsAdministrator('true')).resolves.toBe('canceled');

        const failure = Object.assign(new Error('failed'), { stderr: 'execution error: (-60007)' });
        execFileAsync.mockRejectedValueOnce(failure);
        await expect(runAsAdministrator('true')).rejects.toBe(failure);
    });
});

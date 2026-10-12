import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { WatchHandle, WatchHub, WatchRegistrationOptions } from '../../../watch-hub';
import { AgentHookConfigWatchers } from '../config-watchers';

/**
 * A Claude settings.json linked into a dotfiles checkout that also holds another tool's settings.json one level down.
 * The fake hub records each registration so a test can deliver native events to it directly.
 */
async function linkedSettings(base: string, mode: WatchHandle['mode'] = 'native') {
    const directory = await mkdtemp(join(base, 'caxri-hook-config-watchers-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const claudeHome = join(directory, 'claude');
    const dotfiles = join(directory, 'dotfiles');
    await Promise.all([
        mkdir(claudeHome, { recursive: true }),
        mkdir(join(dotfiles, 'vscode'), { recursive: true }),
    ]);
    await writeFile(join(dotfiles, 'settings.json'), '{}\n', 'utf8');
    await symlink(join(dotfiles, 'settings.json'), join(claudeHome, 'settings.json'));
    const registrations: WatchRegistrationOptions[] = [];
    const watchHub = {
        register: (options: WatchRegistrationOptions) => {
            registrations.push(options);
            return Promise.resolve({
                mode,
                dispose: () => Promise.resolve(),
            } as unknown as WatchHandle);
        },
    } as unknown as WatchHub;
    const onChange = vi.fn();
    const watchers = new AgentHookConfigWatchers({ watchHub, onChange, pollOnce: vi.fn() });
    const configPath = join(claudeHome, 'settings.json');
    const firstRefresh = await watchers.refresh([configPath]);
    const canonicalDotfiles = join(await realpath(directory), 'dotfiles');
    const deliver = (root: string, path: string) =>
        registrations
            .find((registration) => registration.root === root)!
            .onEvents([{ type: 'update', path }]);
    return {
        canonicalDotfiles,
        claudeHome,
        configPath,
        deliver,
        directory,
        firstRefresh,
        onChange,
        registrations,
        watchers,
    };
}

describe('AgentHookConfigWatchers', () => {
    it('ignores a same-named file nested under a watched link target directory', async () => {
        const { canonicalDotfiles, deliver, onChange } = await linkedSettings(
            await realpath(tmpdir()),
        );

        deliver(canonicalDotfiles, join(canonicalDotfiles, 'vscode', 'settings.json'));
        expect(onChange).not.toHaveBeenCalled();

        deliver(canonicalDotfiles, join(canonicalDotfiles, 'settings.json'));
        expect(onChange).toHaveBeenCalledOnce();
    });

    it('matches the canonical event path of a config directory registered through a non-canonical path', async () => {
        // On macOS `tmpdir()` is under `/var`, which native events report as `/private/var`.
        const { claudeHome, deliver, onChange } = await linkedSettings(tmpdir());

        deliver(claudeHome, join(await realpath(claudeHome), 'settings.json'));
        expect(onChange).toHaveBeenCalledOnce();
    });

    it('reports a file as newly watched only on the refresh that first covers it', async () => {
        const { configPath, directory, firstRefresh, watchers } = await linkedSettings(tmpdir());
        expect(firstRefresh).toBe(true);
        expect(await watchers.refresh([configPath])).toBe(false);

        // A repointed link brings a target no registration covered, which the caller must read once more.
        const otherSettings = join(directory, 'other-dotfiles', 'claude.json');
        await mkdir(join(directory, 'other-dotfiles'));
        await writeFile(otherSettings, '{}\n', 'utf8');
        await symlink(otherSettings, `${configPath}.next`);
        await rename(`${configPath}.next`, configPath);
        expect(await watchers.refresh([configPath])).toBe(true);
        expect(await watchers.refresh([configPath])).toBe(false);
    });

    it('does not report the files of a replaced polling registration as newly watched', async () => {
        const { configPath, registrations, watchers } = await linkedSettings(tmpdir(), 'polling');
        const registered = registrations.length;

        // Every refresh retries a degraded directory natively; counting that as new would reconcile in a loop.
        expect(await watchers.refresh([configPath])).toBe(false);
        expect(registrations.length).toBeGreaterThan(registered);
    });
});

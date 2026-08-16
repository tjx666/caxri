import { mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ShellIntegrationService } from '../shell-integration';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('ShellIntegrationService', () => {
    it('maps zsh and bash to controlled content-free OSC 133 startup scripts', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-shell-integration-'));
        temporaryDirectories.push(directory);
        const service = await ShellIntegrationService.create(directory);
        const environment = { HOME: '/Users/example', PATH: '/usr/bin' };

        const zsh = service.resolve('/bin/zsh', environment);
        const bash = service.resolve('/bin/bash', environment);
        expect(zsh).toMatchObject({ args: ['-l'] });
        expect(zsh?.environment.ZDOTDIR).toBe(join(directory, 'shell-integration'));
        expect(bash?.args).toEqual([
            '--init-file',
            join(directory, 'shell-integration/bashrc'),
            '-i',
        ]);
        const sources = await Promise.all(
            ['.zshenv', '.zprofile', '.zshrc', '.zlogin', 'bashrc'].map((name) =>
                readFile(join(directory, 'shell-integration', name), 'utf8'),
            ),
        );
        expect(sources.join('\n')).toContain('133;A');
        expect(sources.join('\n')).toContain('133;D;%d');
        expect(sources.join('\n')).not.toMatch(/history|command_text|terminal\.input/iu);
        expect((await stat(join(directory, 'shell-integration/bashrc'))).mode & 0o777).toBe(0o600);
    });

    it('leaves unsupported shells unmodified', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-shell-integration-'));
        temporaryDirectories.push(directory);
        const service = await ShellIntegrationService.create(directory);

        expect(service.resolve('/bin/fish', { HOME: '/Users/example' })).toBeUndefined();
    });

    it('never follows a stale script symlink while refreshing controlled files', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-shell-integration-'));
        temporaryDirectories.push(directory);
        await ShellIntegrationService.create(directory);
        const target = join(directory, 'outside-script');
        const bashrc = join(directory, 'shell-integration/bashrc');
        await writeFile(target, 'keep me', 'utf8');
        await unlink(bashrc);
        await symlink(target, bashrc);

        await expect(ShellIntegrationService.create(directory)).rejects.toThrow();
        expect(await readFile(target, 'utf8')).toBe('keep me');
    });
});

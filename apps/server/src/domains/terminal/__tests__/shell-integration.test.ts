import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { managedAgentShellExecutable, ShellIntegrationService } from '../shell-integration';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

describe('ShellIntegrationService', () => {
    it.each([
        { managed: true, interrupts: 2, userTrap: false },
        { managed: false, interrupts: 1, userTrap: false },
        { managed: true, interrupts: 1, userTrap: true },
    ])(
        'preserves deliberate startup cancellation and user traps ($managed, $userTrap)',
        async ({ managed, interrupts, userTrap }) => {
            const directory = await mkdtemp(join(tmpdir(), 'caxri-shell-startup-cancel-'));
            temporaryDirectories.push(directory);
            await writeFile(
                join(directory, '.zshrc'),
                [
                    ...(userTrap ? ['function TRAPINT() { return 0 }'] : []),
                    ...Array.from({ length: interrupts }, () => 'kill -INT $$'),
                    'alias cxy=true',
                ].join('\n'),
            );
            const service = await ShellIntegrationService.create(directory);
            const launch = service.resolve('/bin/zsh', { HOME: directory, PATH: '/usr/bin:/bin' });
            if (!launch) throw new Error('Missing zsh integration');
            const result = spawnSync('/bin/zsh', ['-i', ...launch.args], {
                cwd: directory,
                env: {
                    ...launch.environment,
                    ...(managed && {
                        CAXRI_AGENT_LAUNCHER_RUNTIME: '/usr/bin/true',
                        CAXRI_AGENT_LAUNCHER_ENTRY: 'fixture',
                        CAXRI_AGENT_LAUNCHER_SOCKET: 'fixture',
                        CAXRI_AGENT_LAUNCHER_ID: 'fixture',
                        CAXRI_AGENT_LAUNCHER_TOKEN: 'fixture',
                    }),
                },
                encoding: 'utf8',
                timeout: 5_000,
                input: [
                    '[[ $ZDOTDIR == $HOME ]] && print FIXTURE_DIRECTORY_RESTORED',
                    '[[ -z ${CAXRI_SHELL_INTEGRATION_DIR+x}${CAXRI_USER_ZDOTDIR+x}${__caxri_startup_trap+x} ]] && print FIXTURE_METADATA_CLEAN',
                    'print FIXTURE_ALIAS:${+aliases[cxy]}:TRAP:${+functions[TRAPINT]}',
                    'exit 0',
                    '',
                ].join('\n'),
            });
            expect(result.error).toBeUndefined();
            expect(result.status).toBe(0);
            expect(result.stdout).toContain('FIXTURE_DIRECTORY_RESTORED');
            expect(result.stdout).toContain('FIXTURE_METADATA_CLEAN');
            expect(result.stdout).toContain(
                userTrap ? 'FIXTURE_ALIAS:1:TRAP:1' : 'FIXTURE_ALIAS:0:TRAP:0',
            );
            expect(result.stdout).toContain('\u{1B}]133;A\u{7}');
        },
    );

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

    it('runs the managed Agent launcher without leaking its fixed environment into the shell', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-shell-integration-'));
        temporaryDirectories.push(directory);
        await ShellIntegrationService.create(directory);

        const sources = await Promise.all(
            ['.zshenv', 'bashrc'].map((name) =>
                readFile(join(directory, 'shell-integration', name), 'utf8'),
            ),
        );
        const fixedEnvironment = [
            'CAXRI_AGENT_LAUNCHER_RUNTIME',
            'CAXRI_AGENT_LAUNCHER_ENTRY',
            'CAXRI_AGENT_LAUNCHER_SOCKET',
            'CAXRI_AGENT_LAUNCHER_ID',
            'CAXRI_AGENT_LAUNCHER_TOKEN',
        ];

        for (const source of sources) {
            const launcherStart = source.indexOf('function __caxri_launch_managed_agent()');
            expect(launcherStart).toBeGreaterThanOrEqual(0);
            const userStartup = source.includes('__caxri_user_zdotdir')
                ? source.indexOf('source "$__caxri_user_zdotdir/.zshenv"')
                : source.indexOf('source /etc/profile');
            expect(userStartup).toBeGreaterThan(launcherStart);
            const launcherEnd = source.indexOf(
                'unset -f __caxri_launch_managed_agent',
                launcherStart,
            );
            const launcherSource = source.slice(
                launcherStart,
                launcherEnd + 'unset -f __caxri_launch_managed_agent'.length,
            );
            const fixedEnvironmentUnset = `unset ${fixedEnvironment.join(' ')}`;

            for (const name of fixedEnvironment) {
                expect(launcherSource).toContain(`\"\${${name}-}\"`);
            }
            expect(launcherSource).toContain(fixedEnvironmentUnset);
            expect(launcherSource.indexOf('set +x')).toBeLessThan(
                launcherSource.indexOf('CAXRI_AGENT_LAUNCHER_TOKEN-'),
            );
            expect(launcherSource.indexOf(fixedEnvironmentUnset)).toBeLessThan(
                launcherSource.indexOf(
                    'CAXRI_AGENT_LAUNCHER_TOKEN="$__caxri_agent_launcher_token"',
                ),
            );
            expect(launcherSource).toContain(
                'if [[ -n "$__caxri_agent_launcher_runtime" && ' +
                    '-n "$__caxri_agent_launcher_entry" && ' +
                    '-n "$__caxri_agent_launcher_socket" && ' +
                    '-n "$__caxri_agent_launcher_id" && ' +
                    '-n "$__caxri_agent_launcher_token" ]]',
            );
            expect(launcherSource).toContain(
                '"$__caxri_agent_launcher_runtime" "$__caxri_agent_launcher_entry" ' +
                    '--managed-agent-launcher "$__caxri_agent_launcher_socket" ' +
                    '"$__caxri_agent_launcher_id"',
            );
            expect(launcherSource).toContain(
                'unset __caxri_agent_launcher_runtime __caxri_agent_launcher_entry ' +
                    '__caxri_agent_launcher_socket __caxri_agent_launcher_id ' +
                    '__caxri_agent_launcher_token',
            );
            expect(
                launcherSource.indexOf(
                    'unset __caxri_agent_launcher_runtime __caxri_agent_launcher_entry',
                ),
            ).toBeGreaterThan(
                launcherSource.indexOf(
                    '"$__caxri_agent_launcher_runtime" "$__caxri_agent_launcher_entry"',
                ),
            );
            expect(launcherSource).not.toMatch(/\beval\b/u);
            expect(launcherSource).not.toMatch(/\bexec\b/u);
        }
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

describe('managedAgentShellExecutable', () => {
    it('keeps an integrated shell and falls back to a shell the platform actually ships', () => {
        expect(managedAgentShellExecutable('/usr/bin/bash', 'linux')).toBe('/usr/bin/bash');
        expect(managedAgentShellExecutable('/usr/bin/fish', 'linux')).toBe('/bin/bash');
        expect(managedAgentShellExecutable('/opt/homebrew/bin/fish', 'darwin')).toBe('/bin/zsh');
    });
});

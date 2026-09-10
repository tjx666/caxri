import { describe, expect, it, vi } from 'vitest';

import type { ExternalStatusCommandDependencies } from '../command';
import { externalStatusCommandOperation, runExternalStatusCommand } from '../command';

describe('runExternalStatusCommand', () => {
    it('preserves numeric process exit codes for diagnostics', async () => {
        await expect(
            runExternalStatusCommand('git', ['status'], '/fixture', {
                run: () => Promise.reject(Object.assign(new Error('fixture failure'), { code: 2 })),
            }),
        ).rejects.toMatchObject({ command: 'git', kind: 'other', exitCode: 2 });
    });

    it.each(['gh', 'vc', 'linear'] as const)(
        'resolves %s through the shared login-path boundary',
        async (command) => {
            const resolveExecutable = vi.fn((name: string) =>
                Promise.resolve(`/login/bin/${name}`),
            );
            const run = vi.fn<NonNullable<ExternalStatusCommandDependencies['run']>>(() =>
                Promise.resolve({ stdout: 'ok', stderr: '' }),
            );

            await expect(
                runExternalStatusCommand(command, ['status'], '/repo', {
                    resolveExecutable,
                    environment: () =>
                        Promise.resolve({ HOME: '/home/user', PATH: '/login/bin:/usr/bin' }),
                    run,
                }),
            ).resolves.toBe('ok');
            expect(resolveExecutable).toHaveBeenCalledWith(command);
            expect(run).toHaveBeenCalledOnce();
            expect(run.mock.calls[0]?.[0]).toBe(`/login/bin/${command}`);
            expect(run.mock.calls[0]?.[1]).toEqual(['status']);
            expect(run.mock.calls[0]?.[2]).toEqual({
                cwd: '/repo',
                env: {
                    CI: '1',
                    HOME: '/home/user',
                    LC_ALL: 'C',
                    PATH: '/login/bin:/usr/bin',
                    ...(command === 'linear' && { LINEAR_API_KEY: '' }),
                },
                maxBuffer: 4 * 1024 * 1024,
                timeout: 8_000,
            });
        },
    );

    it('preserves the not-found classification for a genuinely missing CLI', async () => {
        await expect(
            runExternalStatusCommand('gh', [], '/repo', {
                resolveExecutable: () => Promise.resolve(undefined),
            }),
        ).rejects.toMatchObject({ command: 'gh', kind: 'not-found' });
    });

    it('prevents linear-cli from loading a Project API key through dotenv', async () => {
        const run = vi.fn<NonNullable<ExternalStatusCommandDependencies['run']>>(() =>
            Promise.resolve({ stdout: 'ok', stderr: '' }),
        );

        await runExternalStatusCommand('linear', ['api', 'query'], '/repo', {
            resolveExecutable: () => Promise.resolve('/login/bin/linear'),
            environment: () =>
                Promise.resolve({
                    HOME: '/home/user',
                    LINEAR_API_KEY: 'stale-project-key',
                    PATH: '/login/bin',
                }),
            run,
        });

        expect(run.mock.calls[0]?.[2].env).toMatchObject({ LINEAR_API_KEY: '' });
    });
});

describe('externalStatusCommandOperation', () => {
    it('does not include arbitrary REST paths or subcommands in operation names', () => {
        expect(externalStatusCommandOperation('gh', ['api', 'PRIVATE_ENDPOINT'])).toBe('unknown');
        expect(externalStatusCommandOperation('gh', ['pr', 'PRIVATE_COMMAND'])).toBe('unknown');
    });
    it('keeps the REST quota probe attributable without logging user content', () => {
        expect(externalStatusCommandOperation('gh', ['api', 'rate_limit'])).toBe('api.rate_limit');
    });

    it('reports a pull-request read without its repository or branch', () => {
        expect(
            externalStatusCommandOperation('gh', [
                'pr',
                'view',
                'feature/secret-branch',
                '--repo',
                'acme/private',
            ]),
        ).toBe('pr.view');
    });
});

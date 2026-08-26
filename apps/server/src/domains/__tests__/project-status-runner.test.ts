import { describe, expect, it, vi } from 'vitest';

import type { CliFailureKind, ProjectStatusCommandDependencies } from '../project-status-external';
import { projectStatusCliError, runProjectStatusCommand } from '../project-status-external';

const NON_LOG_FAILURE_KINDS: Array<Exclude<CliFailureKind, 'other'>> = [
    'not-found',
    'not-logged-in',
    'not-linked',
    'rate-limited',
    'timeout',
];

describe('runProjectStatusCommand', () => {
    it.each(['gh', 'vc', 'linear'] as const)(
        'resolves %s through the shared login-path boundary',
        async (command) => {
            const resolveExecutable = vi.fn((name: string) =>
                Promise.resolve(`/login/bin/${name}`),
            );
            const run = vi.fn<NonNullable<ProjectStatusCommandDependencies['run']>>(() =>
                Promise.resolve({ stdout: 'ok', stderr: '' }),
            );

            await expect(
                runProjectStatusCommand(command, ['status'], '/repo', {
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
            runProjectStatusCommand('gh', [], '/repo', {
                resolveExecutable: () => Promise.resolve(undefined),
            }),
        ).rejects.toMatchObject({ command: 'gh', kind: 'not-found' });
    });

    it('prevents linear-cli from loading a Project API key through dotenv', async () => {
        const run = vi.fn<NonNullable<ProjectStatusCommandDependencies['run']>>(() =>
            Promise.resolve({ stdout: 'ok', stderr: '' }),
        );

        await runProjectStatusCommand('linear', ['api', 'query'], '/repo', {
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

    it.each(NON_LOG_FAILURE_KINDS)('keeps %s errors non-actionable', (kind) => {
        expect(projectStatusCliError('linear', kind)).not.toHaveProperty('detailsView');
    });

    it('routes generic CLI failure details to Logs', () => {
        expect(projectStatusCliError('linear', 'other')).toHaveProperty('detailsView', 'logs');
    });
});

import { describe, expect, it, vi } from 'vitest';

import type { ProjectStatusCommandDependencies } from '../project-status';
import { runProjectStatusCommand } from '../project-status';

describe('runProjectStatusCommand', () => {
    it.each(['gh', 'vc', 'linear'] as const)(
        'resolves %s through the shared login-path boundary',
        async (command) => {
            const resolveExecutable = vi.fn((name: string) =>
                Promise.resolve(`/login/bin/${name}`),
            );
            const run = vi.fn<NonNullable<ProjectStatusCommandDependencies['run']>>(() =>
                Promise.resolve({ stdout: 'ok' }),
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
            expect(run.mock.calls[0]?.[2]).toMatchObject({
                cwd: '/repo',
                env: {
                    CI: '1',
                    HOME: '/home/user',
                    LC_ALL: 'C',
                    PATH: '/login/bin:/usr/bin',
                },
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
});

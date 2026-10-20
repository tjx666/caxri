import { describe, expect, it, vi } from 'vitest';

import type { ExternalStatusCommandDependencies } from '../command';
import {
    externalStatusCommandOperation,
    GITHUB_RATE_LIMIT_QUERY,
    runExternalStatusCommand,
} from '../command';
import { GitHubTokenCache } from '../github-token';

function fixedToken(token = 'gho_fixture'): GitHubTokenCache {
    return new GitHubTokenCache(
        () => Promise.resolve(token),
        () => false,
    );
}

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
                    githubToken: fixedToken(),
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
                    ...(command === 'gh' && { GH_TOKEN: 'gho_fixture' }),
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

    it.each([
        ['fetch failed ECONNRESET', 'network'],
        ['certificate has expired', 'tls'],
        // Each provider words being signed out differently; all of them name the login command, so that is what is
        // matched. Getting this wrong costs the user the one sentence that would have fixed it.
        [
            "No authentication found. Run 'lh login' first, or set LOBEHUB_CLI_API_KEY.",
            'not-logged-in',
        ],
        ['gh: To get started with GitHub CLI, please run: gh auth login', 'not-logged-in'],
        ['Error: No existing credentials found. Please run `vc login`', 'not-logged-in'],
        [
            'GraphQL: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.',
            'permission-denied',
        ],
        [
            "GraphQL: Your token has not been granted the required scopes to execute this query. The 'login' field requires one of the following scopes: ['read:org']",
            'permission-denied',
        ],
        ['HTTP 403: API rate limit exceeded for user', 'rate-limited'],
    ] as const)('classifies %s for the status UI', async (message, kind) => {
        await expect(
            runExternalStatusCommand('vc', ['ls'], '/repo', {
                resolveExecutable: () => Promise.resolve('/login/bin/vc'),
                run: () => Promise.reject(new Error(message)),
            }),
        ).rejects.toMatchObject({ command: 'vc', kind });
    });

    it('classifies gh exit code 4 under CI=1 as not-logged-in', async () => {
        await expect(
            runExternalStatusCommand('gh', ['pr', 'view'], '/repo', {
                resolveExecutable: () => Promise.resolve('/bin/gh'),
                run: () =>
                    Promise.reject(
                        Object.assign(new Error('Command failed'), {
                            code: 4,
                            stderr: 'gh: To use GitHub CLI in automation, set the GH_TOKEN environment variable.',
                        }),
                    ),
            }),
        ).rejects.toMatchObject({ command: 'gh', kind: 'not-logged-in' });
        await expect(
            runExternalStatusCommand('vc', ['ls'], '/repo', {
                resolveExecutable: () => Promise.resolve('/bin/vc'),
                run: () => Promise.reject(Object.assign(new Error('x'), { code: 4, stderr: 'x' })),
            }),
        ).rejects.toMatchObject({ command: 'vc', kind: 'other' });
    });

    it('reads the gh token once for concurrent calls and passes it to each call', async () => {
        const run = vi.fn<NonNullable<ExternalStatusCommandDependencies['run']>>(
            (_file, arguments_) =>
                Promise.resolve({
                    stdout: arguments_[0] === 'auth' ? 'gho_once\n' : 'ok',
                    stderr: '',
                }),
        );
        const dependencies = {
            resolveExecutable: () => Promise.resolve('/login/bin/gh'),
            environment: () => Promise.resolve({ PATH: '/login/bin' }),
            run,
        };
        const githubToken = new GitHubTokenCache(
            () =>
                runExternalStatusCommand('gh', ['auth', 'token'], '/home', {
                    ...dependencies,
                    githubToken: fixedToken('unused'),
                }),
            () => false,
        );
        await Promise.all(
            ['a', 'b', 'c'].map((repo) =>
                runExternalStatusCommand('gh', ['pr', 'view', repo], '/repo', {
                    ...dependencies,
                    githubToken,
                }),
            ),
        );
        const authReads = run.mock.calls.filter(([, arguments_]) => arguments_[0] === 'auth');
        expect(authReads).toHaveLength(1);
        const viewCalls = run.mock.calls.filter(([, arguments_]) => arguments_[0] === 'pr');
        expect(viewCalls).toHaveLength(3);
        expect(viewCalls.map((call) => call[2].env.GH_TOKEN)).toEqual([
            'gho_once',
            'gho_once',
            'gho_once',
        ]);
    });

    it('fails gh calls without running gh while its token cannot be read', async () => {
        const run = vi.fn<NonNullable<ExternalStatusCommandDependencies['run']>>();
        const githubToken = new GitHubTokenCache(
            () => Promise.reject(new Error('User canceled the keychain prompt')),
            () => false,
        );
        const dependencies = {
            githubToken,
            resolveExecutable: () => Promise.resolve('/login/bin/gh'),
            run,
        };
        await expect(
            runExternalStatusCommand('gh', ['pr', 'list'], '/repo', dependencies),
        ).rejects.toMatchObject({ command: 'gh', kind: 'other' });
        await expect(
            runExternalStatusCommand('gh', ['pr', 'list'], '/repo', dependencies),
        ).rejects.toMatchObject({ command: 'gh' });
        expect(run).not.toHaveBeenCalled();
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
    it('keeps the quota probe attributable without logging user content', () => {
        expect(
            externalStatusCommandOperation('gh', [
                'api',
                'graphql',
                '-f',
                `query=${GITHUB_RATE_LIMIT_QUERY}`,
            ]),
        ).toBe('graphql.rate_limit');
        // Any other GraphQL document is user-shaped content and must not be named in a log.
        expect(
            externalStatusCommandOperation('gh', [
                'api',
                'graphql',
                '-f',
                'query { viewer { login } }',
            ]),
        ).toBe('unknown');
        expect(externalStatusCommandOperation('gh', ['api', 'rate_limit'])).toBe('unknown');
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

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
    actionArchivePath,
    configureActionCache,
    discoverPinnedActions,
    verifyActionCache,
} from '../configure-actions-runner-cache';
import { execFileAsync } from '../exec';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

async function createActionRepo(root: string): Promise<{ directory: string; sha: string }> {
    const directory = join(root, 'fixture-action');
    await mkdir(directory);
    await execFileAsync('git', ['init', '--quiet'], { cwd: directory });
    await writeFile(
        join(directory, 'action.yml'),
        [
            'name: Fixture action',
            "description: 'Fixture only'",
            'runs:',
            '  using: node24',
            '',
        ].join('\n'),
    );
    await execFileAsync('git', ['add', 'action.yml'], { cwd: directory });
    await execFileAsync(
        'git',
        [
            '-c',
            'user.name=Caxri Tests',
            '-c',
            'user.email=tests@caxri.invalid',
            'commit',
            '--quiet',
            '-m',
            'test: add fixture action',
        ],
        { cwd: directory },
    );
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: directory });
    return { directory, sha: stdout.trim() };
}

async function createConfigFixture(root: string, actionSha: string) {
    const fixtureRepo = join(root, 'repository');
    const runnerDirectory = join(root, 'runner');
    await Promise.all([
        mkdir(join(fixtureRepo, '.github', 'workflows'), { recursive: true }),
        mkdir(join(runnerDirectory, '_work'), { recursive: true }),
    ]);
    await Promise.all([
        writeFile(join(runnerDirectory, '.runner'), '{}\n'),
        writeFile(
            join(runnerDirectory, '.env'),
            ['LANG=en_US.UTF-8', 'ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE=/stale/cache', ''].join('\n'),
        ),
        writeFile(
            join(fixtureRepo, '.github', 'workflows', 'ci.yml'),
            [
                'name: CI',
                'jobs:',
                '  fixture:',
                '    steps:',
                `      - uses: fixture/action@${actionSha}`,
                '',
            ].join('\n'),
        ),
    ]);
    return { fixtureRepository: fixtureRepo, runnerDirectory };
}

describe('GitHub Actions runner archive cache', () => {
    it('keeps every repository action on an immutable commit SHA', async () => {
        await expect(discoverPinnedActions(repoRoot)).resolves.toEqual([
            {
                repository: 'actions/cache',
                sha: '55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
            },
            {
                repository: 'actions/checkout',
                sha: '3d3c42e5aac5ba805825da76410c181273ba90b1',
            },
            {
                repository: 'actions/setup-node',
                sha: '820762786026740c76f36085b0efc47a31fe5020',
            },
            {
                repository: 'actions/upload-artifact',
                sha: '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
            },
            {
                repository: 'pnpm/setup',
                sha: 'c8e77b72cd6022852162c92aa10e7e72b7209c9b',
            },
        ]);
    });

    it('keeps every repository action inside the repository Actions allowlist', async () => {
        // The repository admits only GitHub-owned actions and `pnpm/setup@*`. A workflow that references anything else
        // ends in `startup_failure` before any job runs, which for the required `guards` check blocks every merge.
        const actions = await discoverPinnedActions(repoRoot);
        expect(
            actions.filter(
                ({ repository }) =>
                    !repository.startsWith('actions/') && repository !== 'pnpm/setup',
            ),
        ).toEqual([]);
    });

    it('rejects mutable action tags before attempting to populate the cache', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-action-pin-test-'));
        try {
            await mkdir(join(root, '.github', 'workflows'), { recursive: true });
            await writeFile(
                join(root, '.github', 'workflows', 'ci.yml'),
                ['jobs:', '  test:', '    steps:', '      - uses: actions/checkout@v7', ''].join(
                    '\n',
                ),
            );

            await expect(discoverPinnedActions(root)).rejects.toThrow(
                'must use a full 40-character commit SHA',
            );
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });

    it('creates, reuses, repairs, and verifies runner archive cache entries', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-action-cache-test-'));
        try {
            const actionRepo = await createActionRepo(root);
            const fixture = await createConfigFixture(root, actionRepo.sha);
            const options = {
                repositoryRoot: fixture.fixtureRepository,
                repositoryUrl: () => actionRepo.directory,
                runnerDirectory: fixture.runnerDirectory,
            };

            const first = await configureActionCache(options);
            expect(first.results).toMatchObject([
                {
                    repository: 'fixture/action',
                    sha: actionRepo.sha,
                    status: 'created',
                },
            ]);
            const archive = actionArchivePath(first.cacheDirectory, first.results[0]);
            const { stdout: archiveEntries } = await execFileAsync('tar', ['-tzf', archive]);
            expect(archiveEntries).toContain(`/action.yml`);
            expect(await readFile(join(fixture.runnerDirectory, '.env'), 'utf8')).toBe(
                [
                    'LANG=en_US.UTF-8',
                    `ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE=${first.cacheDirectory}`,
                    '',
                ].join('\n'),
            );

            const second = await configureActionCache(options);
            expect(second.results[0].status).toBe('reused');

            const flatAction = join(root, 'flat-action.yml');
            await writeFile(flatAction, 'name: Invalid flat archive\n');
            await execFileAsync('tar', ['-czf', archive, '-C', root, 'flat-action.yml']);
            const repaired = await configureActionCache(options);
            expect(repaired.results[0].status).toBe('repaired');
            await expect(
                verifyActionCache({
                    repositoryRoot: fixture.fixtureRepository,
                    runnerDirectory: fixture.runnerDirectory,
                }),
            ).resolves.toMatchObject({ actions: [{ repository: 'fixture/action' }] });
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });
});

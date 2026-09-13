import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GitSummary } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, expect, it, vi } from 'vitest';

import type { ExternalStatusRunner } from '../external-status';
import { ExternalStatusCliError } from '../external-status';
import { ProjectStatusService } from '../project-status';

const directories: string[] = [];
const loggers: StructuredLogger[] = [];

afterEach(async () => {
    const pendingLoggers = loggers.slice();
    const pendingDirectories = directories.slice();
    loggers.length = 0;
    directories.length = 0;
    await Promise.all(pendingLoggers.map((logger) => logger.flush()));
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

async function loadFallback(hasLocalLink: boolean, hasTeam: boolean, hasInvalidResponse = false) {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-project-status-fallback-'));
    directories.push(directory);
    const rootPath = join(directory, 'project');
    await mkdir(rootPath);
    if (hasLocalLink) {
        await mkdir(join(rootPath, '.vercel'));
        await writeFile(
            join(rootPath, '.vercel', 'project.json'),
            JSON.stringify({ orgId: 'team_fixture', projectId: 'prj_fixture' }),
        );
    }
    const logger = new StructuredLogger(directory);
    loggers.push(logger);
    const summary: GitSummary = {
        isRepository: true,
        repositories: [
            {
                id: 'repo-1',
                kind: 'primary',
                name: 'project',
                rootPath,
                branch: 'main',
                head: '1234567',
                ahead: 0,
                behind: 0,
                additions: 0,
                deletions: 0,
                generation: 0,
                changedFileCount: 0,
                truncated: false,
                files: [],
            },
        ],
    };
    const refreshed = Promise.withResolvers<void>();
    const runner = vi.fn<ExternalStatusRunner>((command, arguments_) => {
        if (command === 'git' && arguments_[0] === 'remote')
            return Promise.resolve('https://github.com/lobehub/project.git');
        if (command === 'git') return Promise.resolve('');
        if (command === 'gh')
            return Promise.reject(
                new ExternalStatusCliError('gh', 'other', 'No pull requests found'),
            );
        return Promise.resolve(
            hasInvalidResponse
                ? 'not-json'
                : arguments_[0] === 'teams'
                  ? JSON.stringify({ teams: hasTeam ? [{ slug: 'fixture' }] : [] })
                  : '[]',
        );
    });
    const service = new ProjectStatusService(
        { summary: () => Promise.resolve(summary) },
        logger,
        runner,
        {
            emit: (event) => {
                if (event.event === 'projectStatus.changed') refreshed.resolve();
            },
        },
    );

    await service.summary('session-1');
    await refreshed.promise;
    return { repo: (await service.summary('session-1')).repositories[0], logger };
}

it('reports an unlinked Vercel repository instead of hiding Deployments', async () => {
    const { repo } = await loadFallback(false, false);
    expect(repo.deployments).toBeUndefined();
    expect(repo.errors).toContainEqual(
        expect.objectContaining({
            source: 'vercel',
            kind: 'prerequisite',
            message: 'Repository not linked to Vercel',
        }),
    );
});

it.each([
    ['personal', false],
    ['team', true],
] as const)(
    'does not tell a locally linked %s project to run vc link when no deployment matches',
    async (_scope, hasTeam) => {
        const { repo } = await loadFallback(true, hasTeam);
        expect(repo.deployments).toBeUndefined();
        expect(repo.errors).toContainEqual(
            expect.objectContaining({
                source: 'vercel',
                kind: 'prerequisite',
                message: 'No Vercel deployments found',
            }),
        );
        expect(repo.errors).not.toContainEqual(
            expect.objectContaining({ message: 'Repository not linked to Vercel' }),
        );
    },
);

it('records a safe parse reason before offering Logs for malformed Vercel output', async () => {
    const { repo, logger } = await loadFallback(false, false, true);
    expect(repo.errors).toContainEqual(
        expect.objectContaining({
            source: 'vercel',
            detailsView: 'logs',
        }),
    );
    await logger.flush();
    const records = (await readFile(logger.path, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { fields?: Record<string, unknown> });
    expect(
        records.some(
            (record) =>
                record.fields?.failureReason === 'invalid-response' &&
                record.fields.command === 'vc',
        ),
    ).toBe(true);
});

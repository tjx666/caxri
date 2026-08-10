import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { StructuredLogger } from '../../../shared/node/logger';
import { CaxriDatabase } from '../../db/repository';
import { ProjectRootResolver } from '../../project-roots';
import { GitService } from '..';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function git(cwd: string, args: string[]): Promise<void> {
    await execFileAsync('git', args, { cwd });
}

describe('Git ignored entry batches', () => {
    it('does not read ignore rules from an unapproved parent repository', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-ignore-boundary-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'repository', 'package');
        await mkdir(projectRoot, { recursive: true });
        await git(join(directory, 'repository'), ['init', '--quiet']);
        await Promise.all([
            writeFile(join(directory, 'repository', '.gitignore'), '*.log\n', 'utf8'),
            writeFile(join(projectRoot, 'ignored.log'), 'outside rules', 'utf8'),
        ]);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        const session = database.createSession(
            database.createProject(projectRoot).id,
            'shell',
        ).session;
        const service = new GitService(
            new ProjectRootResolver(database),
            new StructuredLogger(join(directory, 'logs')),
        );

        await expect(
            service.ignoredEntries(session.id, projectRoot, ['ignored.log']),
        ).resolves.toEqual({ ignoredNames: new Set(), rulePaths: [] });
        database.close();
    });

    it('uses each listed repository and leaves tracked matches undecorated', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-git-ignore-'));
        temporaryDirectories.push(directory);
        const root = join(directory, 'project');
        const nested = join(root, 'nested');
        const nonGit = join(directory, 'plain-project');
        await Promise.all([
            mkdir(join(root, 'node_modules'), { recursive: true }),
            mkdir(nested, { recursive: true }),
            mkdir(nonGit),
        ]);
        await git(root, ['init', '--quiet']);
        await Promise.all([
            writeFile(join(root, '.gitignore'), '*.log\nnode_modules/\n', 'utf8'),
            writeFile(join(root, 'ignored.log'), 'ignored', 'utf8'),
            writeFile(join(root, 'tracked.log'), 'tracked', 'utf8'),
        ]);
        await git(root, ['add', '--force', 'tracked.log']);
        await git(nested, ['init', '--quiet']);
        await Promise.all([
            writeFile(join(nested, '.gitignore'), '*.nested\n', 'utf8'),
            writeFile(join(nested, 'inside.nested'), 'ignored', 'utf8'),
            writeFile(join(nested, 'inside.log'), 'not ignored by the parent repository', 'utf8'),
        ]);
        const [canonicalRoot, canonicalNested] = await Promise.all([
            realpath(root),
            realpath(nested),
        ]);

        const database = new CaxriDatabase(join(directory, 'state.db'));
        const project = database.createProject(root);
        const session = database.createSession(project.id, 'shell').session;
        const plainSession = database.createSession(
            database.createProject(nonGit).id,
            'shell',
        ).session;
        const logger = new StructuredLogger(join(directory, 'logs'));
        const service = new GitService(new ProjectRootResolver(database), logger);

        await expect(
            service.ignoredEntries(session.id, root, [
                'ignored.log',
                'node_modules',
                'tracked.log',
            ]),
        ).resolves.toEqual({
            ignoredNames: new Set(['ignored.log', 'node_modules']),
            rulePaths: [
                join(canonicalRoot, '.git', 'info', 'exclude'),
                join(canonicalRoot, '.git', 'config'),
                join(canonicalRoot, '.git', 'config.worktree'),
            ],
        });
        await expect(
            service.ignoredEntries(session.id, nested, ['inside.nested', 'inside.log']),
        ).resolves.toEqual({
            ignoredNames: new Set(['inside.nested']),
            rulePaths: [
                join(canonicalNested, '.git', 'info', 'exclude'),
                join(canonicalNested, '.git', 'config'),
                join(canonicalNested, '.git', 'config.worktree'),
            ],
        });
        await expect(
            service.ignoredEntries(plainSession.id, nonGit, ['visible.ts']),
        ).resolves.toEqual({ ignoredNames: new Set(), rulePaths: [] });

        const records = (await readFile(logger.path, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { event: string; fields?: { operation?: string } });
        expect(
            records.filter(
                (record) =>
                    record.event === 'git.command' && record.fields?.operation === 'check-ignore',
            ),
        ).toHaveLength(2);
        database.close();
    });
});

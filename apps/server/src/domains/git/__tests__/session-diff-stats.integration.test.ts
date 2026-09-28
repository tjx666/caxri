import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { ProjectRootResolver } from '../../project-roots';
import { GitService } from '..';

const directories: string[] = [];
const databases: CaxriDatabase[] = [];
const gitServices: GitService[] = [];

afterEach(async () => {
    const servicesToClose = [...gitServices];
    gitServices.length = 0;
    await Promise.allSettled(servicesToClose.map((git) => git.close()));
    for (const database of databases) database.close();
    databases.length = 0;
    const directoriesToRemove = [...directories];
    directories.length = 0;
    await Promise.all(
        directoriesToRemove.map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
}

async function run(cwd: string, ...arguments_: string[]): Promise<void> {
    await execFileAsync('git', arguments_, { cwd });
}

describe('GitService session diff stats', () => {
    it('counts a feature branch from its fork point, including commits, edits, and new files', async () => {
        const remote = await temporaryDirectory('caxri-diff-stats-remote-');
        const directory = await temporaryDirectory('caxri-diff-stats-');
        await run(remote, 'init', '--bare', '-b', 'main');
        await run(directory, 'init', '-b', 'main');
        await run(directory, 'config', 'user.email', 'test@example.com');
        await run(directory, 'config', 'user.name', 'Caxri Test');
        await writeFile(join(directory, 'a.txt'), 'one\ntwo\n', 'utf8');
        await run(directory, 'add', 'a.txt');
        await run(directory, 'commit', '-m', 'initial');
        await run(directory, 'remote', 'add', 'origin', remote);
        await run(directory, 'push', '-u', 'origin', 'main');
        await run(directory, 'remote', 'set-head', 'origin', 'main');

        await run(directory, 'switch', '-c', 'feat/rows');
        await writeFile(join(directory, 'a.txt'), 'one\n2\nthree\n', 'utf8');
        await run(directory, 'commit', '-am', 'committed change');
        await writeFile(join(directory, 'a.txt'), 'one\n2\nthree\nfour\n', 'utf8');
        await writeFile(join(directory, 'new.txt'), 'x\ny\nz\n', 'utf8');

        const support = await temporaryDirectory('caxri-diff-stats-support-');
        const database = new CaxriDatabase(join(support, 'caxri-test.db'));
        databases.push(database);
        const logger = new StructuredLogger(join(support, 'logs'));
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const git = new GitService(new ProjectRootResolver(database), logger);
        gitServices.push(git);

        // Committed: two → 2, + three. Uncommitted: + four. New file: three lines.
        await expect(git.sessionDiffStats([session])).resolves.toEqual({
            stats: { [session.id]: { additions: 6, deletions: 1 } },
        });
    });

    it('does not count a moved submodule pointer as a changed line', async () => {
        const library = await temporaryDirectory('caxri-diff-stats-library-');
        const directory = await temporaryDirectory('caxri-diff-stats-super-');
        await Promise.all(
            [library, directory].map(async (repo) => {
                await run(repo, 'init', '-b', 'main');
                await run(repo, 'config', 'user.email', 'test@example.com');
                await run(repo, 'config', 'user.name', 'Caxri Test');
            }),
        );
        await writeFile(join(library, 'lib.txt'), 'one\n', 'utf8');
        await run(library, 'add', 'lib.txt');
        await run(library, 'commit', '-m', 'library one');
        await run(
            directory,
            '-c',
            'protocol.file.allow=always',
            'submodule',
            'add',
            library,
            'lib',
        );
        await run(directory, 'commit', '-m', 'add submodule');
        await writeFile(join(library, 'lib.txt'), 'one\ntwo\n', 'utf8');
        await run(library, 'commit', '-am', 'library two');
        await run(join(directory, 'lib'), 'pull', '-q', 'origin', 'main');
        await writeFile(join(directory, 'real.txt'), 'edit\n', 'utf8');

        const support = await temporaryDirectory('caxri-diff-stats-support-');
        const database = new CaxriDatabase(join(support, 'caxri-test.db'));
        databases.push(database);
        const logger = new StructuredLogger(join(support, 'logs'));
        const session = database.createSession(
            database.createProject(directory).id,
            'shell',
        ).session;
        const git = new GitService(new ProjectRootResolver(database), logger);
        gitServices.push(git);

        // Only the new file counts; the submodule's `Subproject commit` swap would otherwise add a phantom +1 −1.
        await expect(git.sessionDiffStats([session])).resolves.toEqual({
            stats: { [session.id]: { additions: 1, deletions: 0 } },
        });
    });
});

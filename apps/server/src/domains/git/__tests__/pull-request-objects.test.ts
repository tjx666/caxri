import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GitRepositorySummary } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { GitPullRequestService } from '../pull-request';

const directories: string[] = [];

afterEach(async () => {
    const pending = [...directories];
    directories.length = 0;
    await Promise.all(pending.map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, arguments_: string[], options?: { allowFailure?: boolean }) {
    try {
        return (await execFileAsync('git', arguments_, { cwd })).stdout;
    } catch (error) {
        if (options?.allowFailure) return '';
        throw error;
    }
}

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-pr-objects-'));
    directories.push(directory);
    const remote = join(directory, 'remote');
    const local = join(directory, 'local');
    await git(directory, ['init', '-b', 'main', remote]);
    await git(remote, ['config', 'user.name', 'Caxri Test']);
    await git(remote, ['config', 'user.email', 'test@example.com']);
    await writeFile(join(remote, 'file.txt'), 'base\n');
    await git(remote, ['add', '.']);
    await git(remote, ['commit', '-m', 'base']);
    await git(remote, ['switch', '-c', 'feature']);
    await writeFile(join(remote, 'file.txt'), 'feature\n');
    await git(remote, ['commit', '-am', 'feature']);
    const head = (await git(remote, ['rev-parse', 'HEAD'])).trim();
    await git(directory, ['clone', '--no-local', remote, local]);
    await git(remote, ['switch', 'main']);
    await writeFile(join(remote, 'upstream.txt'), 'upstream\n');
    await git(remote, ['add', '.']);
    await git(remote, ['commit', '-m', 'advance base after clone']);
    const base = (await git(remote, ['rev-parse', 'HEAD'])).trim();
    const repo: GitRepositorySummary = {
        additions: 0,
        ahead: 0,
        behind: 0,
        branch: 'feature',
        changedFileCount: 0,
        deletions: 0,
        files: [],
        generation: 0,
        head,
        id: 'repository',
        kind: 'submodule',
        name: 'local',
        rootPath: local,
        truncated: false,
    };
    const metadata = {
        baseRefName: 'main',
        baseRefOid: base,
        headRefName: 'feature',
        headRefOid: head,
        number: 42,
        title: 'Feature',
        url: 'https://github.com/example/repo/pull/42',
    };
    const commands: string[][] = [];
    const service = new GitPullRequestService({
        git: (cwd, arguments_, options) => {
            commands.push(arguments_);
            return git(cwd, arguments_, options);
        },
        pullRequestView: () => Promise.resolve(JSON.stringify(metadata)),
        resolveRepository: () => Promise.resolve(repo),
    });
    const request = { refresh: 0, repositoryId: repo.id, sessionId: 'session' };
    return { base, commands, head, local, metadata, remote, request, service };
}

describe('pull request commit availability', () => {
    it('loads a missing base without changing refs, FETCH_HEAD, index, or working files', async () => {
        const { base, commands, head, local, request, service } = await fixture();
        expect(await git(local, ['cat-file', '-t', base], { allowFailure: true })).toBe('');
        await writeFile(join(local, '.git', 'FETCH_HEAD'), 'preserve fetch receipt\n');
        await writeFile(join(local, 'file.txt'), 'staged\n');
        await git(local, ['add', 'file.txt']);
        await writeFile(join(local, 'file.txt'), 'unstaged\n');
        const references = await git(local, ['show-ref']);
        const index = await readFile(join(local, '.git', 'index'));
        const result = await service.changes(request);
        expect(result).toMatchObject({ additions: 1, deletions: 1, files: [{ path: 'file.txt' }] });
        expect(await git(local, ['rev-parse', 'HEAD'])).toBe(`${head}\n`);
        expect(await git(local, ['show-ref'])).toBe(references);
        expect(await readFile(join(local, '.git', 'index'))).toEqual(index);
        expect(await readFile(join(local, 'file.txt'), 'utf8')).toBe('unstaged\n');
        expect(await readFile(join(local, '.git', 'FETCH_HEAD'), 'utf8')).toBe(
            'preserve fetch receipt\n',
        );
        expect(commands.filter(([operation]) => operation === 'fetch')).toHaveLength(1);
        expect(await service.diffDocument({ ...request, path: 'file.txt' })).toMatchObject({
            original: 'base\n',
            modified: 'feature\n',
        });
    });

    it('fetches a missing head and reuses local objects on subsequent reads', async () => {
        const { commands, local, metadata, remote, request, service } = await fixture();
        await git(local, ['fetch', 'origin', 'main']);
        await git(remote, ['switch', 'feature']);
        await writeFile(join(remote, 'file.txt'), 'next feature\n');
        await git(remote, ['commit', '-am', 'advance feature']);
        metadata.headRefOid = (await git(remote, ['rev-parse', 'HEAD'])).trim();
        await expect(service.changes(request)).resolves.toMatchObject({
            files: [{ path: 'file.txt' }],
        });
        const fetchCount = commands.filter(([operation]) => operation === 'fetch').length;
        expect(fetchCount).toBe(1);
        await service.changes({ ...request, refresh: 1 });
        expect(commands.filter(([operation]) => operation === 'fetch')).toHaveLength(fetchCount);
    });

    it('fails with an actionable error and permits retry after the remote is restored', async () => {
        const { commands, local, remote, request, service } = await fixture();
        await git(local, ['remote', 'set-url', 'origin', join(remote, 'missing')]);
        await expect(service.changes(request)).rejects.toMatchObject({
            code: 'GIT',
            message:
                'Required pull request commits could not be downloaded. Check remote access and refresh.',
        });
        expect(commands.filter(([operation]) => operation === 'fetch')).toHaveLength(1);
        await git(local, ['remote', 'set-url', 'origin', remote]);
        await expect(service.changes({ ...request, refresh: 1 })).resolves.toMatchObject({
            number: 42,
        });
    });
});

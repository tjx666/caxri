import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { execFileAsync, StructuredLogger } from '@caxri/system';
import type parcelWatcher from '@parcel/watcher';
import { describe, expect, it, vi } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { ProjectRootResolver } from '../../project/roots';
import { GitService } from '..';

async function gitAt(cwd: string, ...arguments_: string[]): Promise<string> {
    return (await execFileAsync('git', arguments_, { cwd })).stdout.trim();
}

async function initialize(root: string): Promise<void> {
    await mkdir(root, { recursive: true });
    await gitAt(root, 'init', '-b', 'main');
    await gitAt(root, 'config', 'user.name', 'Caxri Test');
    await gitAt(root, 'config', 'user.email', 'test@example.com');
    await writeFile(join(root, 'tracked.txt'), 'before\n');
    await gitAt(root, 'add', 'tracked.txt');
    await gitAt(root, 'commit', '-m', 'initial');
}

describe('child repository metadata invalidation', () => {
    it.each([
        { kind: 'submodule', native: false, linked: false },
        { kind: 'nested', native: false, linked: false },
        { kind: 'submodule', native: false, linked: true },
        { kind: 'submodule', native: true, linked: true },
    ])(
        'refreshes committed $kind (native=$native, linked=$linked) without manual refresh',
        async ({ kind, native, linked }) => {
            const temporaryDirectory = await mkdtemp(join(tmpdir(), 'caxri-child-meta-'));
            const directory = await realpath(temporaryDirectory);
            const root = join(directory, 'project');
            if (linked) {
                await initialize(join(directory, 'primary'));
                await gitAt(join(directory, 'primary'), 'worktree', 'add', '-b', 'linked', root);
            }
            const child = join(root, 'child');
            const callbacks = new Map<string, parcelWatcher.SubscribeCallback>();
            const events: ServerEvent[] = [];
            const logger = new StructuredLogger(join(directory, 'logs'));
            const database = new CaxriDatabase(join(directory, 'test.db'));
            let service: GitService | undefined;
            try {
                if (!linked) await initialize(root);
                if (kind === 'submodule') {
                    const source = join(directory, 'source');
                    await initialize(source);
                    await gitAt(
                        root,
                        '-c',
                        'protocol.file.allow=always',
                        'submodule',
                        'add',
                        source,
                        'child',
                    );
                    await gitAt(root, 'commit', '-am', 'add child');
                    await gitAt(child, 'config', 'user.name', 'Caxri Test');
                    await gitAt(child, 'config', 'user.email', 'test@example.com');
                } else await initialize(child);
                await writeFile(join(child, 'tracked.txt'), 'after\n');
                const session = database.createSession(
                    database.createProject(root).id,
                    'shell',
                ).session;
                service = new GitService(new ProjectRootResolver(database), logger, {
                    emit: (event) => events.push(event),
                    subscribe: native
                        ? undefined
                        : (path, callback) => {
                              callbacks.set(path, callback);
                              return Promise.resolve({
                                  unsubscribe: () => {
                                      callbacks.delete(path);
                                      return Promise.resolve();
                                  },
                              });
                          },
                });
                const before = await service.summary(session.id);
                const originalChild = before.repositories.find((repo) => repo.rootPath === child);
                expect(originalChild?.files.map((file) => file.path)).toEqual(['tracked.txt']);
                if (!native) await vi.waitFor(() => expect(callbacks.size).toBe(2));
                await gitAt(child, 'add', 'tracked.txt');
                await gitAt(child, 'commit', '-m', 'commit child edit');
                expect(await gitAt(child, 'status', '--porcelain')).toBe('');
                const gitDirectory = await gitAt(child, 'rev-parse', '--absolute-git-dir');
                /**
                 * Deliver the real commit's metadata paths through every covering native subscription.
                 */
                for (const [watchedRoot, callback] of callbacks) {
                    const paths = ['index', 'HEAD', 'refs/heads/main'].map((path) =>
                        join(gitDirectory, path),
                    );
                    const covered = paths.filter(
                        (path) => !relative(watchedRoot, path).startsWith('..'),
                    );
                    if (covered.length > 0)
                        callback(
                            null,
                            covered.map((path) => ({ path, type: 'update' })),
                        );
                }
                await vi.waitFor(async () => {
                    const after = await service!.summary(session.id);
                    const updated = after.repositories.find((repo) => repo.rootPath === child);
                    expect(updated?.files).toEqual([]);
                    expect(updated?.head).not.toBe(originalChild?.head);
                });
                await vi.waitFor(() =>
                    expect(
                        events.some(
                            (event) =>
                                event.event === 'git.changed' &&
                                event.payload.sessionIds.includes(session.id),
                        ),
                    ).toBe(true),
                );
                if (!native) {
                    const sibling = database.createSession(session.projectId, 'shell').session;
                    await service.summary(sibling.id);
                    service.evictSessions([session.id]);
                    expect(callbacks.size).toBe(2);
                    service.evictSessions([sibling.id]);
                    await vi.waitFor(() => expect(callbacks.size).toBe(0));
                }
            } finally {
                await service?.close();
                database.close();
                await logger.flush();
                await rm(directory, { recursive: true, force: true });
            }
        },
    );
});

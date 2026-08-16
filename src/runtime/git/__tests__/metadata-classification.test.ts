import { sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyGitMetadataPath } from '../metadata-watcher';

function path(...segments: string[]): string {
    return segments.join(sep);
}

describe('classifyGitMetadataPath', () => {
    it('classifies primary-worktree status metadata', () => {
        expect(classifyGitMetadataPath('HEAD')).toEqual({
            kind: 'status',
            scope: 'worktree',
            gitDirName: undefined,
        });
        expect(classifyGitMetadataPath('index')).toMatchObject({ kind: 'status' });
        expect(classifyGitMetadataPath('MERGE_HEAD')).toMatchObject({ kind: 'status' });
        expect(classifyGitMetadataPath('REBASE_HEAD')).toMatchObject({ kind: 'status' });
    });

    it('classifies shared ref changes as shared-scope status', () => {
        expect(classifyGitMetadataPath(path('refs', 'heads', 'main'))).toEqual({
            kind: 'status',
            scope: 'shared',
        });
        expect(classifyGitMetadataPath('packed-refs')).toEqual({
            kind: 'status',
            scope: 'shared',
        });
    });

    it('classifies linked-worktree metadata to its gitDir entry', () => {
        expect(classifyGitMetadataPath(path('worktrees', 'feature-x', 'HEAD'))).toEqual({
            kind: 'status',
            scope: 'worktree',
            gitDirName: 'feature-x',
        });
        expect(classifyGitMetadataPath(path('worktrees', 'feature-x', 'index'))).toMatchObject({
            gitDirName: 'feature-x',
        });
    });

    it('classifies topology-affecting changes', () => {
        expect(classifyGitMetadataPath('worktrees')).toEqual({ kind: 'topology' });
        expect(classifyGitMetadataPath(path('worktrees', 'feature-x'))).toEqual({
            kind: 'topology',
        });
        expect(classifyGitMetadataPath(path('worktrees', 'feature-x', 'gitdir'))).toEqual({
            kind: 'topology',
        });
        expect(classifyGitMetadataPath('config')).toEqual({ kind: 'topology' });
        expect(classifyGitMetadataPath(path('info', 'exclude'))).toEqual({ kind: 'topology' });
    });

    it('ignores object churn, locks, cookies, and fsmonitor state', () => {
        expect(classifyGitMetadataPath(path('objects', 'ab', 'cdef'))).toBeUndefined();
        expect(classifyGitMetadataPath(path('logs', 'HEAD'))).toBeUndefined();
        expect(classifyGitMetadataPath(path('hooks', 'pre-commit'))).toBeUndefined();
        expect(classifyGitMetadataPath('index.lock')).toBeUndefined();
        expect(classifyGitMetadataPath(path('refs', 'heads', 'main.lock'))).toBeUndefined();
        expect(
            classifyGitMetadataPath(path('worktrees', 'feature-x', 'index.lock')),
        ).toBeUndefined();
        expect(classifyGitMetadataPath(path('worktrees', 'feature-x', 'locked'))).toBeUndefined();
        expect(classifyGitMetadataPath('.watchman-cookie-host-1')).toBeUndefined();
        expect(classifyGitMetadataPath('fsmonitor--daemon.ipc')).toBeUndefined();
        expect(classifyGitMetadataPath('')).toBeUndefined();
        expect(classifyGitMetadataPath('ORIG_HEAD.lock')).toBeUndefined();
        expect(classifyGitMetadataPath('COMMIT_EDITMSG')).toBeUndefined();
    });
});

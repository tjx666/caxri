import type { GitOverview } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
    sessionChangeCount,
    sessionChangesPresentation,
    sessionChangesQueryParameters,
    sessionChangesScope,
    shouldShowSessionChanges,
} from '../session-changes';
import {
    claimSessionChangesReader,
    releaseSessionChangesReader,
    useSessionChangesReaderStore,
} from '../session-changes-reader-store';

type OverviewRepo = GitOverview['repositories'][number];

function repo(overrides: Partial<OverviewRepo> = {}): OverviewRepo {
    return {
        id: 'repo-primary',
        kind: 'primary',
        name: 'sample-app',
        rootPath: '/workspace/sample-app',
        branch: 'main',
        ahead: 0,
        behind: 0,
        additions: 0,
        deletions: 0,
        generation: 1,
        changedFileCount: 0,
        truncated: false,
        ...overrides,
    };
}

const selected = { id: 'session-selected', workbenchProjectId: 'project-app' };

afterEach(() => {
    useSessionChangesReaderStore.setState({ readerId: undefined });
});

describe('Session card change scope', () => {
    it('separates the selected Session, its root siblings, and other roots', () => {
        expect(sessionChangesScope(selected, selected)).toBe('selected');
        expect(
            sessionChangesScope(
                { id: 'session-sibling', workbenchProjectId: 'project-app' },
                selected,
            ),
        ).toBe('watched');
        expect(
            sessionChangesScope(
                { id: 'session-worktree', workbenchProjectId: 'project-app-worktree' },
                selected,
            ),
        ).toBe('unwatched');
        expect(sessionChangesScope(selected, undefined)).toBe('unwatched');
    });

    it('reads only for an open card describing another Session', () => {
        expect(shouldShowSessionChanges(undefined)).toBe(false);
        expect(shouldShowSessionChanges('selected')).toBe(false);
        expect(shouldShowSessionChanges('watched')).toBe(true);
        expect(shouldShowSessionChanges('unwatched')).toBe(true);
    });

    it('asks for a refreshed snapshot only where no file watcher advances it', () => {
        expect(sessionChangesQueryParameters('session-a', 'unwatched')).toEqual({
            sessionId: 'session-a',
            refresh: true,
        });
        expect(sessionChangesQueryParameters('session-a', 'watched')).toEqual({
            sessionId: 'session-a',
        });
        expect(sessionChangesQueryParameters('session-a', undefined)).toEqual({
            sessionId: 'session-a',
        });
    });
});

describe('Session card change reader', () => {
    it('lets the latest open card read and ignores a stale release', () => {
        claimSessionChangesReader('card-a');
        claimSessionChangesReader('card-b');
        expect(useSessionChangesReaderStore.getState().readerId).toBe('card-b');

        releaseSessionChangesReader('card-a');
        expect(useSessionChangesReaderStore.getState().readerId).toBe('card-b');

        releaseSessionChangesReader('card-b');
        expect(useSessionChangesReaderStore.getState().readerId).toBeUndefined();
    });
});

describe('Session change count', () => {
    it('sums the untruncated totals of every repository in the Workbench Root', () => {
        expect(
            sessionChangeCount({
                isRepository: true,
                repositories: [
                    repo({ changedFileCount: 2_400, truncated: true }),
                    repo({ id: 'repo-nested', kind: 'nested', changedFileCount: 3 }),
                ],
            }),
        ).toBe(2_403);
    });

    it('reports zero for a clean repository', () => {
        expect(sessionChangeCount({ isRepository: true, repositories: [repo()] })).toBe(0);
    });

    it('has no count when there is no repository or the read failed', () => {
        expect(sessionChangeCount(undefined)).toBeUndefined();
        expect(sessionChangeCount({ isRepository: false, repositories: [] })).toBeUndefined();
        expect(
            sessionChangeCount({
                isRepository: true,
                repositories: [repo({ changedFileCount: 4 })],
                error: 'git status failed',
            }),
        ).toBeUndefined();
    });
});

describe('Session changes presentation', () => {
    it('hides the row when the tree is clean or the count is unknown', () => {
        expect(sessionChangesPresentation(0)).toBeUndefined();
        expect(sessionChangesPresentation(undefined)).toBeUndefined();
    });

    it('describes the working tree rather than the Session Agent', () => {
        expect(sessionChangesPresentation(1)).toEqual({
            ariaLabel: 'Working tree has 1 uncommitted change.',
            value: '1',
        });
        expect(sessionChangesPresentation(12)).toEqual({
            ariaLabel: 'Working tree has 12 uncommitted changes.',
            value: '12',
        });
    });
});

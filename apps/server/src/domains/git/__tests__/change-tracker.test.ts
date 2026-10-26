import { resolve, sep } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { GitChangeTracker } from '../change-tracker';

const REPO_KEY = '/repo/.git';

function createTracker(delayMs = 5) {
    const events: ServerEvent[] = [];
    const tracker = new GitChangeTracker({
        delayMs,
        emit: (event) => {
            events.push(event);
        },
        repositoryId: (rootPath) => `id:${rootPath}`,
    });
    return { events, tracker };
}

describe('GitChangeTracker', () => {
    it('retains child groups and invalidates every Session projecting their topology', async () => {
        const { events, tracker } = createTracker();
        const childKey = '/repo/.git/modules/child';
        tracker.registerSession('parent', '/repo', [REPO_KEY, childKey], ['/repo', '/repo/child']);
        tracker.registerSession('child', '/repo/child', [childKey], ['/repo/child']);
        expect([...tracker.referencedRepositoryKeys()]).toEqual([REPO_KEY, childKey]);
        tracker.scheduleTopologyChanged(childKey);
        await vi.waitFor(() => expect(events).toHaveLength(1));
        expect(events[0].payload).toMatchObject({
            scope: 'topology',
            sessionIds: ['parent', 'child'],
        });
        tracker.evictSessions(['child']);
        expect([...tracker.referencedRepositoryKeys()]).toEqual([REPO_KEY, childKey]);
        tracker.close();
    });

    it('maps changed paths to the deepest containing repository root', () => {
        const { tracker } = createTracker();
        tracker.registerSession('session-1', '/repo', [REPO_KEY], ['/repo', '/repo/vendor/child']);
        const groups = tracker.groupChangesByRoot('session-1', [
            `vendor${sep}child${sep}lib.ts`,
            'src/app.ts',
        ]);
        expect(Object.fromEntries(groups)).toEqual({
            '/repo': [resolve('/repo', 'src/app.ts')],
            '/repo/vendor/child': [resolve('/repo', `vendor${sep}child${sep}lib.ts`)],
        });
    });

    it('ignores paths outside every registered root and unknown sessions', () => {
        const { tracker } = createTracker();
        tracker.registerSession('session-1', '/elsewhere', [REPO_KEY], ['/repo']);
        expect(tracker.groupChangesByRoot('session-1', ['src/app.ts']).size).toBe(0);
        expect(tracker.groupChangesByRoot('missing', ['src/app.ts']).size).toBe(0);
    });

    it('coalesces a burst of bumps into one git.changed event', async () => {
        const { events, tracker } = createTracker();
        tracker.registerSession('session-1', '/repo', [REPO_KEY], ['/repo']);
        tracker.scheduleStatusChanged(['/repo']);
        tracker.scheduleStatusChanged(['/repo']);
        tracker.scheduleStatusChanged(['/repo']);
        expect(events).toHaveLength(0);
        await vi.waitFor(() => expect(events).toHaveLength(1));
        expect(events[0]).toEqual({
            event: 'git.changed',
            payload: {
                repositoryIds: ['id:/repo'],
                scope: 'status',
                sessionIds: ['session-1'],
            },
        });
    });

    it('notifies every session projecting the affected repository, not only the writer', async () => {
        const { events, tracker } = createTracker();
        tracker.registerSession('session-a', '/repo', [REPO_KEY], ['/repo']);
        tracker.registerSession('session-b', '/repo', [REPO_KEY], ['/repo']);
        tracker.registerSession('session-c', '/other', ['other-key'], ['/other']);
        tracker.scheduleStatusChanged(['/repo']);
        await vi.waitFor(() => expect(events).toHaveLength(1));
        expect(events[0].payload).toMatchObject({
            scope: 'status',
            sessionIds: ['session-a', 'session-b'],
        });
    });

    it('escalates the pending scope to topology and fans out over the repository group', async () => {
        const { events, tracker } = createTracker();
        tracker.registerSession('session-a', '/repo', [REPO_KEY], ['/repo']);
        tracker.registerSession('session-b', '/repo-linked', [REPO_KEY], ['/repo-linked']);
        tracker.scheduleStatusChanged(['/repo']);
        tracker.scheduleTopologyChanged(REPO_KEY);
        await vi.waitFor(() => expect(events).toHaveLength(1));
        expect(events[0].payload).toMatchObject({
            scope: 'topology',
            sessionIds: ['session-a', 'session-b'],
        });
        // The next flush reverts to plain status scope.
        tracker.scheduleStatusChanged(['/repo']);
        await vi.waitFor(() => expect(events).toHaveLength(2));
        expect(events[1].payload).toMatchObject({ scope: 'status' });
    });

    it('stops emitting for evicted sessions and after close', async () => {
        const { events, tracker } = createTracker();
        tracker.registerSession('session-1', '/repo', [REPO_KEY], ['/repo']);
        tracker.evictSessions(['session-1']);
        expect(tracker.referencedRoots().size).toBe(0);
        expect(tracker.referencedRepositoryKeys().size).toBe(0);
        tracker.scheduleStatusChanged(['/repo']);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(events).toHaveLength(0);
        tracker.registerSession('session-2', '/repo', [REPO_KEY], ['/repo']);
        tracker.close();
        tracker.scheduleStatusChanged(['/repo']);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(events).toHaveLength(0);
    });
});

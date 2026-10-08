import { describe, expect, it } from 'vitest';

import {
    adjacentProjectOrder,
    areProjectDropTargetsEqual,
    createLatestProjectOrderQueue,
    createProjectOrderIntentTracker,
    hasProjectDragType,
    PROJECT_DRAG_TYPE,
    projectOrderAfterDrop,
} from '../project-order';

describe('Project ordering', () => {
    it('inserts a dragged Project before or after the target without dropping ids', () => {
        expect(projectOrderAfterDrop(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b']);
        expect(projectOrderAfterDrop(['a', 'b', 'c'], 'a', 'b', 'after')).toEqual(['b', 'a', 'c']);
    });

    it('leaves malformed or same-target drops unchanged', () => {
        expect(projectOrderAfterDrop(['a', 'b'], 'a', 'a', 'before')).toEqual(['a', 'b']);
        expect(projectOrderAfterDrop(['a', 'b'], 'unknown', 'b', 'after')).toEqual(['a', 'b']);
    });

    it('moves a focused Project one position and stops at either boundary', () => {
        expect(adjacentProjectOrder(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
        expect(adjacentProjectOrder(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
        expect(adjacentProjectOrder(['a', 'b'], 'a', -1)).toBeUndefined();
        expect(adjacentProjectOrder(['a', 'b'], 'b', 1)).toBeUndefined();
    });

    it('treats repeated dragover positions as the same target', () => {
        expect(
            areProjectDropTargetsEqual(
                { edge: 'before', projectId: 'a' },
                { edge: 'before', projectId: 'a' },
            ),
        ).toBe(true);
        expect(
            areProjectDropTargetsEqual(
                { edge: 'before', projectId: 'a' },
                { edge: 'after', projectId: 'a' },
            ),
        ).toBe(false);
        expect(areProjectDropTargetsEqual(undefined, undefined)).toBe(true);
    });

    it('recognizes only the structured Project drag payload', () => {
        expect(hasProjectDragType(['text/plain', PROJECT_DRAG_TYPE])).toBe(true);
        expect(hasProjectDragType(['text/plain'])).toBe(false);
    });

    it('coalesces queued Project permutations to the latest intent', async () => {
        const { promise: firstPending, resolve: releaseFirst } = Promise.withResolvers<void>();
        const persisted: string[][] = [];
        const queue = createLatestProjectOrderQueue(async (projectIds) => {
            persisted.push([...projectIds]);
            if (persisted.length === 1) await firstPending;
        });

        const settled = queue.enqueue(['a', 'b', 'c']);
        // Fire-and-forget: only the final queued permutation's returned promise is awaited below:
        // the queue's "latest wins" contract makes these intermediate results irrelevant.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void queue.enqueue(['b', 'a', 'c']);
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void queue.enqueue(['b', 'c', 'a']);
        expect(persisted).toEqual([['a', 'b', 'c']]);

        releaseFirst();
        await settled;
        expect(persisted).toEqual([
            ['a', 'b', 'c'],
            ['b', 'c', 'a'],
        ]);
    });

    it('abandons queued optimistic orders when an earlier persistence attempt fails', async () => {
        const { promise: firstPending, resolve: releaseFirst } = Promise.withResolvers<void>();
        const firstProjectIds = ['b', 'c', 'a'];
        const secondProjectIds = ['c', 'b', 'a'];
        const tracker = createProjectOrderIntentTracker();
        const persisted: string[][] = [];
        const queue = createLatestProjectOrderQueue(async (projectIds) => {
            const intent = tracker.get();
            if (intent?.projectIds !== projectIds) return;
            persisted.push([...projectIds]);
            if (projectIds === firstProjectIds) await firstPending;
            tracker.settle(projectIds !== firstProjectIds);
        });

        tracker.set({
            displayTitle: 'Alpha',
            movedProjectId: 'a',
            projectIds: firstProjectIds,
        });
        const settled = queue.enqueue(firstProjectIds);
        tracker.set({
            displayTitle: 'Beta',
            movedProjectId: 'b',
            projectIds: secondProjectIds,
        });
        // Fire-and-forget: this test only asserts on the first `settled` promise and the tracker's
        // final state, not on this superseding enqueue's own returned promise.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void queue.enqueue(secondProjectIds);

        releaseFirst();
        await settled;
        expect(persisted).toEqual([firstProjectIds]);
        expect(tracker.get()).toBeUndefined();
    });

    it('retains an acknowledged keyboard order until the matching snapshot arrives', () => {
        const tracker = createProjectOrderIntentTracker();
        const firstIntent = {
            displayTitle: 'Alpha',
            movedProjectId: 'a',
            projectIds: ['b', 'a', 'c'],
        };

        tracker.set(firstIntent);
        tracker.settle(true);

        const secondOrder = adjacentProjectOrder(
            tracker.get()?.projectIds ?? ['a', 'b', 'c'],
            'a',
            1,
        );
        expect(secondOrder).toEqual(['b', 'c', 'a']);

        const secondIntent = { ...firstIntent, projectIds: secondOrder! };
        tracker.set(secondIntent);
        expect(tracker.reconcile(firstIntent.projectIds)).toBeUndefined();
        expect(tracker.get()).toBe(secondIntent);
        expect(tracker.reconcile(secondIntent.projectIds)).toBe(secondIntent);
        expect(tracker.get()).toBeUndefined();
    });

    it('abandons an intent rejected by persistence or invalidated by membership changes', () => {
        const tracker = createProjectOrderIntentTracker();
        const rejected = {
            displayTitle: 'Alpha',
            movedProjectId: 'a',
            projectIds: ['b', 'a'],
        };
        tracker.set(rejected);
        tracker.settle(false);
        expect(tracker.get()).toBeUndefined();

        tracker.set(rejected);
        expect(tracker.reconcile(['a', 'b', 'c'])).toBeUndefined();
        expect(tracker.get()).toBeUndefined();
    });
});

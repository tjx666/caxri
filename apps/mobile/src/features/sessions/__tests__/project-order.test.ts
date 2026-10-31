import { describe, expect, it } from 'vitest';

import {
    orderedProjects,
    projectAutoScrollStep,
    projectChipShift,
    projectDropIndex,
    projectReorder,
} from '../project-order';

const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('orderedProjects', () => {
    it('applies a pending order that names exactly the current Projects', () => {
        expect(orderedProjects(projects, ['c', 'a', 'b']).map(({ id }) => id)).toEqual([
            'c',
            'a',
            'b',
        ]);
    });

    it('keeps the dashboard order without a pending order or once the Projects changed', () => {
        expect(orderedProjects(projects, null)).toBe(projects);
        expect(orderedProjects(projects, ['c', 'a'])).toBe(projects);
        expect(orderedProjects(projects, ['c', 'a', 'd'])).toBe(projects);
    });
});

describe('projectReorder', () => {
    it('anchors a move to the front before the new second Project', () => {
        expect(projectReorder(['a', 'b', 'c'], 'c', 0)).toEqual({
            order: ['c', 'a', 'b'],
            request: { projectId: 'c', anchorProjectId: 'a', placement: 'before' },
        });
    });

    it('anchors any other move after the Project it lands behind', () => {
        expect(projectReorder(['a', 'b', 'c'], 'a', 2)).toEqual({
            order: ['b', 'c', 'a'],
            request: { projectId: 'a', anchorProjectId: 'c', placement: 'after' },
        });
        expect(projectReorder(['a', 'b', 'c'], 'c', 1)?.request).toEqual({
            projectId: 'c',
            anchorProjectId: 'a',
            placement: 'after',
        });
    });

    it('ignores a drop in place or an unknown Project', () => {
        expect(projectReorder(['a', 'b'], 'a', 0)).toBeNull();
        expect(projectReorder(['a', 'b'], 'x', 1)).toBeNull();
    });
});

describe('projectDropIndex and projectChipShift', () => {
    const slots = [
        { x: 0, width: 40 },
        { x: 50, width: 60 },
        { x: 120, width: 40 },
    ];

    it('counts the chips whose center the dragged chip crossed', () => {
        expect(projectDropIndex(slots, 0, 20)).toBe(0);
        expect(projectDropIndex(slots, 0, 81)).toBe(1);
        expect(projectDropIndex(slots, 0, 141)).toBe(2);
        expect(projectDropIndex(slots, 2, 10)).toBe(0);
    });

    it('steps the chips between the old and new place toward the gap', () => {
        expect(projectChipShift(1, 0, 2, 50)).toBe(-50);
        expect(projectChipShift(2, 0, 1, 50)).toBe(0);
        expect(projectChipShift(0, 2, 0, 50)).toBe(50);
        expect(projectChipShift(1, -1, 0, 50)).toBe(0);
    });
});

describe('projectAutoScrollStep', () => {
    const base = { chipWidth: 40, edge: 40, maxOffset: 200, maxStep: 10, viewportWidth: 300 };

    it('scrolls toward the edge the chip is held against', () => {
        expect(projectAutoScrollStep({ ...base, chipLeft: 280, offset: 0 })).toBe(10);
        expect(projectAutoScrollStep({ ...base, chipLeft: 0, offset: 100 })).toBe(-10);
        expect(projectAutoScrollStep({ ...base, chipLeft: 120, offset: 100 })).toBe(0);
    });

    it('stops at either end of the strip', () => {
        expect(projectAutoScrollStep({ ...base, chipLeft: 280, offset: 196 })).toBe(4);
        expect(projectAutoScrollStep({ ...base, chipLeft: 0, offset: 0 })).toBe(0);
    });
});

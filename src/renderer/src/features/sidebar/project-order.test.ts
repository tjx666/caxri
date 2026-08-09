import { describe, expect, it } from 'vitest';

import {
    adjacentProjectOrder,
    projectDropTargetsEqual,
    projectOrderAfterDrop,
} from './project-order';

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
            projectDropTargetsEqual(
                { edge: 'before', projectId: 'a' },
                { edge: 'before', projectId: 'a' },
            ),
        ).toBe(true);
        expect(
            projectDropTargetsEqual(
                { edge: 'before', projectId: 'a' },
                { edge: 'after', projectId: 'a' },
            ),
        ).toBe(false);
        expect(projectDropTargetsEqual(undefined, undefined)).toBe(true);
    });
});

import { describe, expect, it } from 'vitest';

import type { PendingFileOperation } from '../file-operation-state';
import {
    CANCEL_REVEAL_THRESHOLD_MS,
    cancelRevealDelayMs,
    fileOperationsBlockingPath,
    isPathBlockedByFileOperations,
} from '../file-operation-state';

function operation(overrides: Partial<PendingFileOperation> = {}): PendingFileOperation {
    return {
        id: 'operation-1',
        label: 'Copying item…',
        projectId: 'project-1',
        affectedPaths: ['/project/foo'],
        cancelable: false,
        startedAt: 0,
        ...overrides,
    };
}

describe('isPathBlockedByFileOperations', () => {
    it('blocks the affected subtree itself and its descendants', () => {
        const operations = [operation()];

        expect(isPathBlockedByFileOperations(operations, 'project-1', '/project/foo')).toBe(true);
        expect(isPathBlockedByFileOperations(operations, 'project-1', '/project/foo/bar')).toBe(
            true,
        );
    });

    it('does not block an unrelated sibling directory or the Project root', () => {
        const operations = [operation()];

        expect(isPathBlockedByFileOperations(operations, 'project-1', '/project/bar')).toBe(false);
        expect(isPathBlockedByFileOperations(operations, 'project-1', '/project')).toBe(false);
    });

    it('never blocks a different Project even when the path string matches', () => {
        const operations = [operation({ projectId: 'project-2' })];

        expect(isPathBlockedByFileOperations(operations, 'project-1', '/project/foo')).toBe(false);
    });
});

describe('fileOperationsBlockingPath', () => {
    it('returns only the operations whose affected subtree overlaps the path', () => {
        const blocking = operation({ id: 'a', affectedPaths: ['/project/foo'] });
        const unrelated = operation({ id: 'b', affectedPaths: ['/project/bar'] });

        expect(
            fileOperationsBlockingPath([blocking, unrelated], 'project-1', '/project/foo'),
        ).toEqual([blocking]);
    });
});

describe('cancelRevealDelayMs', () => {
    it('waits out the remaining threshold for a cancelable operation', () => {
        const pending = operation({ cancelable: true, startedAt: 1_000 });

        expect(cancelRevealDelayMs(pending, 1_000 + CANCEL_REVEAL_THRESHOLD_MS - 1)).toBe(1);
    });

    it('reveals immediately once a cancelable operation crosses the threshold', () => {
        const pending = operation({ cancelable: true, startedAt: 1_000 });

        expect(cancelRevealDelayMs(pending, 1_000 + CANCEL_REVEAL_THRESHOLD_MS)).toBe(0);
    });

    it('never reveals for a non-cancelable or absent operation', () => {
        const pending = operation({ cancelable: false, startedAt: 0 });

        expect(cancelRevealDelayMs(pending, CANCEL_REVEAL_THRESHOLD_MS * 10)).toBeUndefined();
        expect(cancelRevealDelayMs(undefined, 0)).toBeUndefined();
    });
});

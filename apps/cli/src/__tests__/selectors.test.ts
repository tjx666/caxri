import { describe, expect, it } from 'vitest';

import { resolveSelector } from '../selectors';

const sessions = [
    { id: 'session-1', title: 'Work', projectId: 'project-1' },
    { id: 'session-2', title: 'Work', projectId: 'project-2' },
    { id: 'session-3', title: 'Unique', projectId: 'project-1' },
];

describe('CLI selectors', () => {
    it('accepts opaque IDs and an explicitly requested current context', () => {
        expect(resolveSelector(sessions, 'session-1', { kind: 'Session' }).id).toBe('session-1');
        expect(
            resolveSelector(sessions, 'current', {
                currentId: 'session-3',
                kind: 'Session',
            }).id,
        ).toBe('session-3');
    });

    it('fails closed for duplicate names and reports bounded exact candidates', () => {
        expect(() => resolveSelector(sessions, 'Work', { kind: 'Session' })).toThrow(
            expect.objectContaining({
                code: 'CONFLICT',
                details: {
                    candidates: [
                        { id: 'session-1', title: 'Work', projectId: 'project-1' },
                        { id: 'session-2', title: 'Work', projectId: 'project-2' },
                    ],
                },
            }) as Error,
        );
    });

    it('requires an exact project scope and rejects stale selectors', () => {
        expect(
            resolveSelector(sessions, 'Work', { kind: 'Session', projectId: 'project-2' }).id,
        ).toBe('session-2');
        expect(() =>
            resolveSelector(sessions, 'missing', { kind: 'Session', projectId: 'project-1' }),
        ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }) as Error);
    });
});

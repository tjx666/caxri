import { describe, expect, it } from 'vitest';

import { workbenchRootOptionSchema } from '../domain.js';
import { workbenchInternalMethods, workbenchMethods } from '../workbench-contract.js';

describe('workbenchMethods', () => {
    it('requires an opaque discovery ID rather than a Renderer path for authorization', () => {
        const schema = workbenchMethods['session.authorizeWorkbenchRoot'].params;
        expect(schema.safeParse({ sessionId: 'session', rootPath: '/unapproved' }).success).toBe(
            false,
        );
        expect(
            schema.parse({ sessionId: 'session', worktreeId: 'opaque', rootPath: '/unapproved' }),
        ).toEqual({ sessionId: 'session', worktreeId: 'opaque' });
    });
    it('keeps discovery and Project authorization states consistent', () => {
        const root = {
            worktreeId: 'opaque',
            rootPath: '/worktree',
            branch: 'feature',
            displayTitle: 'worktree',
            isMain: false,
            owner: false,
        };
        expect(
            workbenchRootOptionSchema.safeParse({ ...root, authorization: 'required' }).success,
        ).toBe(true);
        expect(
            workbenchRootOptionSchema.safeParse({ ...root, authorization: 'authorized' }).success,
        ).toBe(false);
        expect(
            workbenchRootOptionSchema.safeParse({
                ...root,
                authorization: 'required',
                projectId: 'project',
            }).success,
        ).toBe(false);
    });
    it('restricts Workbench Root authorization to the Desktop owner while selection stays Server-owned', () => {
        expect(workbenchMethods['session.authorizeWorkbenchRoot'].owner).toBe('desktop');
        expect(workbenchMethods['session.continueInWorktree'].owner).toBe('desktop');
        expect(workbenchMethods['session.selectWorkbenchRoot'].owner).toBe('server');
        expect(workbenchMethods['session.workbenchRoots'].owner).toBe('server');
    });

    it('marks root listing as read and every mutation as write', () => {
        expect(workbenchMethods['session.workbenchRoots'].effect).toBe('read');
        for (const method of [
            'session.selectWorkbenchRoot',
            'session.authorizeWorkbenchRoot',
            'session.dismissWorkbenchCandidate',
            'session.continueInWorktree',
        ] as const) {
            expect(workbenchMethods[method].effect).toBe('write');
        }
    });

    it('accepts a canceled result or a full Session record from Desktop authorization flows', () => {
        const schema = workbenchMethods['session.authorizeWorkbenchRoot'].result;
        expect(schema.safeParse({ canceled: true }).success).toBe(true);
        expect(schema.safeParse({ canceled: false }).success).toBe(false);
    });

    it('requires both sessionId and candidateId for candidate-scoped commands', () => {
        const parameters = workbenchMethods['session.dismissWorkbenchCandidate'].params;
        expect(parameters.safeParse({ sessionId: 'session-1' }).success).toBe(false);
        expect(
            parameters.safeParse({ sessionId: 'session-1', candidateId: 'candidate-1' }).success,
        ).toBe(true);
    });

    it('does not use the display path as candidate authorization input', () => {
        expect(
            workbenchMethods['session.continueInWorktree'].params.parse({
                sessionId: 'session-1',
                candidateId: 'candidate-1',
                rootPath: '/unrelated',
            }),
        ).toEqual({ sessionId: 'session-1', candidateId: 'candidate-1' });
    });
});

describe('workbenchInternalMethods', () => {
    it('keeps internal handoffs Server-owned with only worktree resolution and tear-off listing read-only', () => {
        const readOnly = new Set([
            'session.workbenchRoot.resolve',
            'window.openSessions.listTearOffs',
        ]);
        for (const [method, spec] of Object.entries(workbenchInternalMethods)) {
            expect(spec.owner).toBe('server');
            expect(spec.effect).toBe(readOnly.has(method) ? 'read' : 'write');
        }
    });

    it('defaults an optional sessionId when validating all Workbench roots', () => {
        const parameters = workbenchInternalMethods['session.validateWorkbenchRoots'].params;
        expect(parameters.parse(undefined)).toEqual({});
        expect(parameters.parse({ sessionId: 'session-1' })).toEqual({ sessionId: 'session-1' });
    });

    it('requires a rootPath when claiming a candidate is authorized', () => {
        const parameters = workbenchInternalMethods['session.workbenchCandidate.authorize'].params;
        expect(
            parameters.safeParse({ sessionId: 'session-1', candidateId: 'candidate-1' }).success,
        ).toBe(false);
        expect(
            parameters.safeParse({
                sessionId: 'session-1',
                candidateId: 'candidate-1',
                rootPath: '/private/project',
            }).success,
        ).toBe(true);
    });
});

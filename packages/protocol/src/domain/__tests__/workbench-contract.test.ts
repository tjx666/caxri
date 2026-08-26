import { describe, expect, it } from 'vitest';

import { workbenchInternalMethods, workbenchMethods } from '../workbench-contract.js';

describe('workbenchMethods', () => {
    it('restricts Workbench Root authorization to the Desktop owner while selection stays Host-owned', () => {
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
});

describe('workbenchInternalMethods', () => {
    it('keeps every internal handoff Host-owned and write-effect', () => {
        for (const spec of Object.values(workbenchInternalMethods)) {
            expect(spec.owner).toBe('server');
            expect(spec.effect).toBe('write');
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

    it('requires the Host-injected Endpoint summary for a creation report', () => {
        const parameters = workbenchInternalMethods['session.workbenchRoot.reportCreated'].params;
        expect(parameters.safeParse({ rootPath: '/private/project' }).success).toBe(false);
        expect(
            parameters.safeParse({
                endpoint: {
                    ref: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
                    projectId: 'project-1',
                    sessionId: 'session-1',
                    terminalId: 'terminal-1',
                    provider: 'codex',
                    name: 'Codex',
                    permissionClass: 'standard',
                    messaging: {
                        deliveryMode: 'pull',
                        health: 'ready',
                        reason: 'pull_ready',
                        checkedAt: 1,
                        nextAction: 'use_pull',
                    },
                    expiresAt: 2,
                },
                rootPath: '/private/project',
            }).success,
        ).toBe(true);
    });
});

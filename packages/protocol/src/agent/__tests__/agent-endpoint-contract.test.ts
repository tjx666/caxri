import { describe, expect, it } from 'vitest';

import { agentEndpointMethods } from '../agent-endpoint-contract.js';

describe('agent-endpoint-contract command params', () => {
    it('defaults the no-parameter agent context and list commands to an empty object', () => {
        expect(agentEndpointMethods['agent.context'].params.parse(undefined)).toEqual({});
        expect(agentEndpointMethods['agent.list'].params.parse(undefined)).toEqual({});
    });

    it('defaults the grant TTL and rejects a TTL outside its bounded window', () => {
        const parsed = agentEndpointMethods['agent.grant'].params.parse({
            endpoint: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
            policy: 'debug:read',
        });
        expect(parsed.ttlMs).toBe(900_000);

        expect(
            agentEndpointMethods['agent.grant'].params.safeParse({
                endpoint: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
                policy: 'debug:read',
                ttlMs: 500,
            }).success,
        ).toBe(false);
        expect(
            agentEndpointMethods['agent.grant'].params.safeParse({
                endpoint: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
                policy: 'debug:read',
                ttlMs: 3_600_001,
            }).success,
        ).toBe(false);
    });

    it('rejects a grant policy outside the closed enum', () => {
        expect(
            agentEndpointMethods['agent.grant'].params.safeParse({
                endpoint: { hostId: 'host-1', endpointId: 'endpoint-1', generation: 1 },
                policy: 'root:full',
            }).success,
        ).toBe(false);
    });

    it('requires a generation-scoped capability and one path for worktree provenance', () => {
        const method = agentEndpointMethods['agent.worktree.created'];
        expect(method.requiredCapabilities).toEqual(['worktrees.report']);
        expect(method.effect).toBe('write');
        expect(method.params.safeParse({ rootPath: '/projects/worktree' }).success).toBe(true);
        expect(method.params.safeParse({}).success).toBe(false);
        expect(
            method.result.safeParse({ status: 'ignored', reason: 'baseline_missing' }).success,
        ).toBe(true);
        expect(method.result.safeParse({ status: 'accepted', action: 'candidate' }).success).toBe(
            true,
        );
    });
});

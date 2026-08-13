import { describe, expect, it } from 'vitest';

import { AgentEndpointRegistry } from '..';

const TOKEN = 'ab'.repeat(32);

function begin(registry: AgentEndpointRegistry, overrides: Record<string, unknown> = {}) {
    return registry.begin({
        terminalId: 'terminal-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        provider: 'codex',
        launchId: 'launch-1',
        name: 'Codex',
        permissionClass: 'standard',
        deliveryMode: 'unavailable',
        ...overrides,
    });
}

describe('AgentEndpointRegistry', () => {
    it('stores only a token digest and authenticates the exact generation', () => {
        const registry = new AgentEndpointRegistry('host-1', { token: () => TOKEN });
        const endpoint = begin(registry);

        expect(JSON.stringify(registry)).not.toContain(TOKEN);
        expect(
            registry.authenticate({
                hostId: 'host-1',
                endpointId: endpoint.ref.endpointId,
                generation: endpoint.ref.generation,
                token: TOKEN,
            }),
        ).toMatchObject({
            principal: {
                kind: 'agent',
                endpointId: endpoint.ref.endpointId,
                generation: 1,
                projectIds: ['project-1'],
            },
        });
        expect(() =>
            registry.authenticate({
                hostId: 'host-1',
                endpointId: endpoint.ref.endpointId,
                generation: endpoint.ref.generation + 1,
                token: TOKEN,
            }),
        ).toThrow(expect.objectContaining({ code: 'UNAVAILABLE' }) as Error);
    });

    it('fences restart and retirement by endpoint, generation, and launch ID', () => {
        const tokens = [TOKEN, 'cd'.repeat(32)];
        const registry = new AgentEndpointRegistry('host-1', { token: () => tokens.shift()! });
        const first = begin(registry);
        const second = begin(registry, { launchId: 'launch-2' });

        expect(second.ref.generation).toBe(2);
        expect(() =>
            registry.authenticate({
                hostId: 'host-1',
                endpointId: first.ref.endpointId,
                generation: first.ref.generation,
                token: TOKEN,
            }),
        ).toThrow(expect.objectContaining({ code: 'UNAVAILABLE' }) as Error);
        expect(registry.retire({ ref: second.ref, launchId: 'launch-1' })).toBe(false);
        expect(
            registry.authenticate({
                hostId: 'host-1',
                endpointId: second.ref.endpointId,
                generation: second.ref.generation,
                token: 'cd'.repeat(32),
            }).principal.kind,
        ).toBe('agent');
        expect(registry.retire({ ref: second.ref, launchId: 'launch-2' })).toBe(true);
    });

    it('expires and revokes generation-scoped grants without transferring them', () => {
        let now = 10_000;
        const tokens = [TOKEN, 'cd'.repeat(32)];
        const registry = new AgentEndpointRegistry('host-1', {
            now: () => now,
            token: () => tokens.shift()!,
        });
        const first = begin(registry);
        const grant = registry.grant(first.ref, 'debug:read', 1_000);
        expect(
            registry.authenticate({
                hostId: 'host-1',
                endpointId: first.ref.endpointId,
                generation: 1,
                token: TOKEN,
            }).capabilities,
        ).toContain('diagnostics.read');

        now = grant.expiresAt;
        expect(
            registry.authenticate({
                hostId: 'host-1',
                endpointId: first.ref.endpointId,
                generation: 1,
                token: TOKEN,
            }).capabilities,
        ).not.toContain('diagnostics.read');
        const second = begin(registry, { launchId: 'launch-2' });
        expect(registry.grants(second.ref)).toEqual([]);
    });

    it('projects only same-Project peers while owner sees duplicate display names', () => {
        const tokens = [TOKEN, 'cd'.repeat(32), 'ef'.repeat(32)];
        const registry = new AgentEndpointRegistry('host-1', { token: () => tokens.shift()! });
        const own = begin(registry);
        begin(registry, { terminalId: 'terminal-2', launchId: 'launch-2', name: 'Codex' });
        begin(registry, {
            terminalId: 'terminal-3',
            sessionId: 'session-2',
            projectId: 'project-2',
            launchId: 'launch-3',
            name: 'Codex',
        });
        const agent = registry.authenticate({
            hostId: 'host-1',
            endpointId: own.ref.endpointId,
            generation: own.ref.generation,
            token: TOKEN,
        });
        const owner = {
            capabilities: ['agents.read'] as const,
            principal: { kind: 'human-cli' as const, id: 'owner' },
        };

        expect(registry.list(agent)).toHaveLength(2);
        expect(registry.list(owner)).toHaveLength(3);
        expect(registry.list(owner).map(({ name }) => name)).toEqual(['Codex', 'Codex', 'Codex']);
    });
});

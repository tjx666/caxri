import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

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
        messaging: {
            deliveryMode: 'unavailable',
            health: 'unsupported',
            reason: 'adapter_unavailable',
            checkedAt: 1,
            nextAction: 'restart_terminal',
        },
        ...overrides,
    });
}

function activate(
    registry: AgentEndpointRegistry,
    endpoint: ReturnType<typeof begin>,
    launchId = 'launch-1',
) {
    expect(registry.activate({ ref: endpoint.ref, launchId })).toBe(true);
}

describe('AgentEndpointRegistry', () => {
    it('grants delegation without granting general Terminal or Agent control', () => {
        let now = 1;
        const registry = new AgentEndpointRegistry('host-1', {
            token: () => TOKEN,
            now: () => now,
        });
        const endpoint = begin(registry);
        activate(registry, endpoint);
        const credential = { ...endpoint.ref, token: TOKEN };
        expect(registry.authenticate(credential).capabilities).not.toContain('agents.delegate');
        registry.grant(endpoint.ref, 'agent:delegate', 1_000);
        const granted = registry.authenticate(credential).capabilities;
        expect(granted).toContain('agents.delegate');
        expect(granted).not.toContain('agents.control');
        expect(granted).not.toContain('agents.dispatch');
        expect(granted).not.toContain('terminals.steer');
        now = 2_000;
        expect(registry.authenticate(credential).capabilities).not.toContain('agents.delegate');
    });

    it('grants the Agent Commander role board and delegation authority without general control', () => {
        const registry = new AgentEndpointRegistry('host-1', { token: () => TOKEN });
        const commander = begin(registry, { role: 'commander' });
        const ordinary = begin(registry, { terminalId: 'terminal-2', launchId: 'launch-2' });
        activate(registry, commander);
        activate(registry, ordinary, 'launch-2');

        const granted = registry.authenticate({ ...commander.ref, token: TOKEN }).capabilities;
        expect(granted).toEqual(expect.arrayContaining(['agents.delegate', 'commander']));
        expect(granted).not.toContain('agents.control');
        expect(granted).not.toContain('terminals.steer');
        expect(registry.authenticate({ ...ordinary.ref, token: TOKEN }).capabilities).not.toContain(
            'commander',
        );
    });

    it('keeps a pre-spawn credential pending until its exact launch activates', () => {
        const registry = new AgentEndpointRegistry('host-1', { token: () => TOKEN });
        const endpoint = begin(registry);
        const credential = { ...endpoint.ref, token: TOKEN };

        expect(() => registry.authenticate(credential)).toThrow(
            expect.objectContaining({ code: 'UNAVAILABLE' }) as Error,
        );
        expect(
            registry.list({
                capabilities: ['agents.read'],
                principal: { kind: 'human-cli', id: 'owner' },
            }),
        ).toEqual([]);
        expect(() => registry.resolve(endpoint.ref)).toThrow(
            expect.objectContaining({ code: 'UNAVAILABLE' }) as Error,
        );
        expect(registry.activate({ ref: endpoint.ref, launchId: 'wrong-launch' })).toBe(false);
        activate(registry, endpoint);
        expect(registry.authenticate(credential).principal.kind).toBe('agent');
    });

    it('stores only a token digest and authenticates the exact generation', () => {
        const registry = new AgentEndpointRegistry('host-1', { token: () => TOKEN });
        const endpoint = begin(registry);
        activate(registry, endpoint);

        expect(JSON.stringify(registry)).not.toContain(TOKEN);
        const authenticated = registry.authenticate({
            hostId: 'host-1',
            endpointId: endpoint.ref.endpointId,
            generation: endpoint.ref.generation,
            token: TOKEN,
        });
        expect(authenticated).toMatchObject({
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
        activate(registry, second, 'launch-2');

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
        activate(registry, first);
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
        activate(registry, second, 'launch-2');
        expect(registry.grants(second.ref)).toEqual([]);
    });

    it('grants control separately and retains only an inert exact wake tombstone', () => {
        const registry = new AgentEndpointRegistry('host-1', { token: () => TOKEN });
        const endpoint = begin(registry);
        activate(registry, endpoint);
        registry.grant(endpoint.ref, 'agent:control', 60_000);
        expect(
            registry.authenticate({
                hostId: 'host-1',
                endpointId: endpoint.ref.endpointId,
                generation: endpoint.ref.generation,
                token: TOKEN,
            }).capabilities,
        ).toEqual(expect.arrayContaining(['agents.dispatch', 'agents.control']));
        expect(registry.retire({ ref: endpoint.ref, launchId: 'launch-1' })).toBe(true);
        expect(registry.resolveRetired(endpoint.ref)).toMatchObject({
            terminalId: 'terminal-1',
            projectId: 'project-1',
        });
        expect(() => registry.resolve(endpoint.ref)).toThrow(
            expect.objectContaining({ code: 'UNAVAILABLE' }) as Error,
        );
        expect(JSON.stringify(registry.resolveRetired(endpoint.ref))).not.toContain(TOKEN);
    });

    it('projects only same-Project peers while owner sees duplicate display names', () => {
        const tokens = [TOKEN, 'cd'.repeat(32), 'ef'.repeat(32)];
        const registry = new AgentEndpointRegistry('host-1', { token: () => tokens.shift()! });
        const own = begin(registry);
        const peer = begin(registry, {
            terminalId: 'terminal-2',
            launchId: 'launch-2',
            name: 'Codex',
        });
        const otherProject = begin(registry, {
            terminalId: 'terminal-3',
            sessionId: 'session-2',
            projectId: 'project-2',
            launchId: 'launch-3',
            name: 'Codex',
        });
        activate(registry, own);
        activate(registry, peer, 'launch-2');
        activate(registry, otherProject, 'launch-3');
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

    it('keeps a monotonic generation across restart retirement of the same live Terminal', () => {
        const tokens = [TOKEN, 'cd'.repeat(32), 'ef'.repeat(32)];
        const registry = new AgentEndpointRegistry('host-1', { token: () => tokens.shift()! });
        begin(registry);
        registry.retireTerminal('terminal-1');
        const second = begin(registry, { launchId: 'launch-2' });
        expect(second.ref.generation).toBe(2);
        registry.retireTerminal('terminal-1');
        const third = begin(registry, { launchId: 'launch-3' });
        expect(third.ref.generation).toBe(3);
    });

    it('recycles generation state when a Terminal is permanently forgotten', () => {
        const registry = new AgentEndpointRegistry('host-1', { token: () => TOKEN });
        const generations = Reflect.get(registry, 'generations') as Map<string, unknown>;
        for (let index = 0; index < 100; index += 1) {
            begin(registry, { terminalId: `terminal-${index}` });
            registry.forgetTerminal(`terminal-${index}`);
        }
        expect(generations).toHaveLength(0);
    });

    it('recycles owned generations on Session and Project deletion without crossing scopes', () => {
        const registry = new AgentEndpointRegistry('host-1', { token: () => TOKEN });
        const generations = Reflect.get(registry, 'generations') as Map<string, unknown>;
        begin(registry, { terminalId: 'terminal-a', sessionId: 'session-1' });
        const survivor = begin(registry, {
            terminalId: 'terminal-b',
            sessionId: 'session-2',
            launchId: 'launch-b',
        });
        activate(registry, survivor, 'launch-b');
        begin(registry, {
            terminalId: 'terminal-c',
            sessionId: 'session-3',
            projectId: 'project-2',
        });
        // Session-owned Terminals stay recycled even when their endpoint already retired earlier
        // (the Terminal exited before the Session was deleted).
        registry.retireTerminal('terminal-a');
        expect(generations).toHaveLength(3);

        registry.forgetSession('session-1');
        expect(generations.keys().toArray()).toEqual(['terminal-b', 'terminal-c']);
        expect(() => registry.resolveTerminal('terminal-b')).not.toThrow();

        registry.forgetProject('project-2');
        expect(generations.keys().toArray()).toEqual(['terminal-b']);
        expect(() => registry.resolveTerminal('terminal-b')).not.toThrow();
    });

    it('updates messaging health only for the exact live launch generation', () => {
        const registry = new AgentEndpointRegistry('host-1', { token: () => TOKEN });
        const endpoint = begin(registry);
        activate(registry, endpoint);
        const changed: string[] = [];
        registry.onMessagingChanged((summary) => {
            changed.push(summary.messaging.reason);
        });
        const messaging = {
            deliveryMode: 'pull' as const,
            health: 'ready' as const,
            reason: 'pull_ready' as const,
            checkedAt: 2,
            nextAction: 'use_pull' as const,
        };

        expect(
            registry.updateMessaging({ ref: endpoint.ref, launchId: 'stale-launch', messaging }),
        ).toBe(false);
        expect(
            registry.updateMessaging({ ref: endpoint.ref, launchId: 'launch-1', messaging }),
        ).toBe(true);
        expect(registry.resolve(endpoint.ref).messaging).toEqual(messaging);
        expect(changed).toEqual(['pull_ready']);
    });

    it('notifies a later messagingChanged listener when an earlier one throws', () => {
        const write = vi.fn();
        const registry = new AgentEndpointRegistry('host-1', {
            token: () => TOKEN,
            logger: { write } as unknown as StructuredLogger,
        });
        const endpoint = begin(registry);
        activate(registry, endpoint);
        const failing = vi.fn(() => {
            throw new Error('messagingChanged listener failure');
        });
        const surviving = vi.fn();
        registry.onMessagingChanged(failing);
        registry.onMessagingChanged(surviving);
        const messaging = {
            deliveryMode: 'pull' as const,
            health: 'ready' as const,
            reason: 'pull_ready' as const,
            checkedAt: 2,
            nextAction: 'use_pull' as const,
        };

        expect(
            registry.updateMessaging({ ref: endpoint.ref, launchId: 'launch-1', messaging }),
        ).toBe(true);

        expect(failing).toHaveBeenCalledTimes(1);
        expect(surviving).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith(
            'warn',
            'agent_endpoint.messaging_changed_listener_failed',
            { fields: { error: 'messagingChanged listener failure' } },
        );
    });

    it('notifies a later retired listener when an earlier one throws', () => {
        const write = vi.fn();
        const registry = new AgentEndpointRegistry('host-1', {
            token: () => TOKEN,
            logger: { write } as unknown as StructuredLogger,
        });
        begin(registry);
        const failing = vi.fn(() => {
            throw new Error('retired listener failure');
        });
        const surviving = vi.fn();
        registry.onRetired(failing);
        registry.onRetired(surviving);

        registry.retireTerminal('terminal-1');

        expect(failing).toHaveBeenCalledTimes(1);
        expect(surviving).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith('warn', 'agent_endpoint.retired_listener_failed', {
            fields: { error: 'retired listener failure' },
        });
    });
});

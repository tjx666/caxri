import { describe, expect, it } from 'vitest';

import { HookLaunchRegistry } from '../launch-registry';

function createHarness() {
    const active = new Map<string, string>();
    const registrations = new Map<string, { launchId: string; terminalId: string }>();
    let tokenNumber = 0;

    const registry = new HookLaunchRegistry({
        activate: (terminalId, launch) => {
            active.set(terminalId, launch.launchId);
        },
        deactivate: (terminalId) => {
            active.delete(terminalId);
        },
        register: (terminalId, launchId) => {
            const token = `token-${++tokenNumber}`;
            registrations.set(token, { launchId, terminalId });
            return token;
        },
        unregister: (token) => {
            registrations.delete(token);
        },
    });

    return { active, registry, registrations };
}

describe('HookLaunchRegistry', () => {
    it('switches the active context from the Shell to its managed Agent child', () => {
        const { active, registry, registrations } = createHarness();
        const shell = registry.shell('terminal-1');

        expect(active.get('terminal-1')).toBe(shell.launchId);
        expect(registrations.get(shell.token)).toEqual({
            launchId: shell.launchId,
            terminalId: 'terminal-1',
        });

        const agent = registry.agent('terminal-1', 'agent-1', 'codex');

        expect(active.get('terminal-1')).toBe('agent-1');
        expect(registrations.has(shell.token)).toBe(true);
        expect(registrations.get(agent.token)).toEqual({
            launchId: 'agent-1',
            terminalId: 'terminal-1',
        });
    });

    it('restores Shell observation after the matching managed Agent exits', () => {
        const { active, registry, registrations } = createHarness();
        const shell = registry.shell('terminal-1');
        const agent = registry.agent('terminal-1', 'agent-1', 'codex');

        registry.endAgent('terminal-1', agent.launchId);

        expect(registrations.has(agent.token)).toBe(false);
        expect(registrations.has(shell.token)).toBe(true);
        expect(active.get('terminal-1')).toBe(shell.launchId);
    });

    it('does not let a stale Agent exit retire a newer managed generation', () => {
        const { active, registry, registrations } = createHarness();
        const shell = registry.shell('terminal-1');
        const firstAgent = registry.agent('terminal-1', 'agent-1', 'codex');
        const secondAgent = registry.agent('terminal-1', 'agent-2', 'codex');

        registry.endAgent('terminal-1', firstAgent.launchId);

        expect(registrations.has(firstAgent.token)).toBe(false);
        expect(registrations.has(secondAgent.token)).toBe(true);
        expect(active.get('terminal-1')).toBe(secondAgent.launchId);
        expect(registrations.has(shell.token)).toBe(true);
    });

    it('does not resurrect Shell observation after the whole PTY retires Shell first', () => {
        const { active, registry, registrations } = createHarness();
        const shell = registry.shell('terminal-1');
        const agent = registry.agent('terminal-1', 'agent-1', 'codex');

        registry.endShell('terminal-1');
        registry.endAgent('terminal-1', agent.launchId);

        expect(registrations.has(shell.token)).toBe(false);
        expect(registrations.has(agent.token)).toBe(false);
        expect(active.has('terminal-1')).toBe(false);
    });

    it('revokes replaced contexts and every remaining context on close', () => {
        const { active, registry, registrations } = createHarness();
        const firstShell = registry.shell('terminal-1');
        const secondShell = registry.shell('terminal-1');
        const agent = registry.agent('terminal-1', 'agent-1', 'codex');
        const otherShell = registry.shell('terminal-2');

        expect(registrations.has(firstShell.token)).toBe(false);
        expect(registrations.has(secondShell.token)).toBe(true);

        registry.close();

        expect(registrations.size).toBe(0);
        expect(active.size).toBe(0);
        expect(registrations.has(agent.token)).toBe(false);
        expect(registrations.has(otherShell.token)).toBe(false);

        registry.close();
        expect(registrations.size).toBe(0);
        expect(active.size).toBe(0);
    });
});

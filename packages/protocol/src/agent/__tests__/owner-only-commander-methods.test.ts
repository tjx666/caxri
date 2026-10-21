import { describe, expect, it } from 'vitest';

import { methods } from '../../registry/method-registry.js';

/**
 * `commander.*` control or write methods that are not owner-only. Each is gated by a capability no Agent Endpoint holds
 * (`desktop` or `commander`; Agent grants only ever add `agents.*`, `projects.*`, `sessions.read`, and similar), so
 * `principal: 'owner'` would add nothing. Adding to this list needs the same justification.
 */
const capabilityGatedExemptions = new Set([
    'commander.ensure',
    'commander.stop',
    'commander.switchAgent',
    'commander.clearData',
    'commander.session.create',
    'commander.session.archive',
    'commander.task.create',
    'commander.task.update',
    'commander.inbox.add',
    'commander.inbox.resolve',
    'commander.inbox.ack',
    'commander.inbox.reply',
    'commander.inbox.dismiss',
    'commander.inbox.merge',
]);

const agentReachableCapabilities = new Set([
    'agents.read',
    'agents.message',
    'agents.delegate',
    'agents.control',
    'agents.dispatch',
    'projects.read',
    'projects.write',
    'sessions.read',
    'terminals.read',
]);

describe('owner-only commander methods', () => {
    const commanderMethods = Object.entries(methods).filter(([name]) =>
        name.startsWith('commander.'),
    ) as Array<
        [string, { effect: string; principal?: 'owner'; requiredCapabilities: readonly string[] }]
    >;

    it('declares hand-over methods owner-only in the spec', () => {
        for (const name of [
            'commander.session.handOver',
            'commander.session.takeBack',
            'commander.conversations',
            'commander.managedSessions',
        ])
            expect(methods[name as keyof typeof methods]).toMatchObject({ principal: 'owner' });
    });

    it('makes every Agent-reachable commander.* method owner-only or an explicit exemption', () => {
        const open = commanderMethods
            .filter(([, spec]) =>
                spec.requiredCapabilities.some((c) => agentReachableCapabilities.has(c)),
            )
            .filter(([, spec]) => spec.principal !== 'owner')
            .map(([name]) => name);
        expect(open).toEqual([]);
    });

    it('keeps every control or write commander.* method owner-only or exempt', () => {
        const unaccounted = commanderMethods
            .filter(([, spec]) => spec.effect !== 'read' && spec.principal !== 'owner')
            .map(([name]) => name)
            .filter((name) => !capabilityGatedExemptions.has(name));
        expect(unaccounted).toEqual([]);
    });

    it('keeps exemptions free of Agent-reachable capabilities', () => {
        for (const [name, spec] of commanderMethods)
            if (capabilityGatedExemptions.has(name))
                expect(
                    spec.requiredCapabilities.some((c) => agentReachableCapabilities.has(c)),
                ).toBe(false);
    });
});

import { describe, expect, it } from 'vitest';

import { methods } from '../../registry/method-registry.js';

/**
 * `bot.*` control or write methods that are not owner-only. Each is gated by a capability no Agent Endpoint holds
 * (`desktop` or `bot`; Agent grants only ever add `agents.*`, `projects.*`, `sessions.read`, and similar), so
 * `principal: 'owner'` would add nothing. Adding to this list needs the same justification.
 */
const capabilityGatedExemptions = new Set([
    'bot.ensure',
    'bot.stop',
    'bot.switchAgent',
    'bot.clearData',
    'bot.session.create',
    'bot.session.archive',
    'bot.task.create',
    'bot.task.update',
    'bot.inbox.add',
    'bot.inbox.resolve',
    'bot.inbox.ack',
    'bot.inbox.reply',
    'bot.inbox.dismiss',
    'bot.inbox.merge',
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

describe('owner-only bot methods', () => {
    const botMethods = Object.entries(methods).filter(([name]) => name.startsWith('bot.')) as Array<
        [string, { effect: string; principal?: 'owner'; requiredCapabilities: readonly string[] }]
    >;

    it('declares hand-over methods owner-only in the spec', () => {
        for (const name of [
            'bot.session.handOver',
            'bot.session.takeBack',
            'bot.conversations',
            'bot.managedSessions',
        ])
            expect(methods[name as keyof typeof methods]).toMatchObject({ principal: 'owner' });
    });

    it('makes every Agent-reachable bot.* method owner-only or an explicit exemption', () => {
        const open = botMethods
            .filter(([, spec]) =>
                spec.requiredCapabilities.some((c) => agentReachableCapabilities.has(c)),
            )
            .filter(([, spec]) => spec.principal !== 'owner')
            .map(([name]) => name);
        expect(open).toEqual([]);
    });

    it('keeps every control or write bot.* method owner-only or exempt', () => {
        const unaccounted = botMethods
            .filter(([, spec]) => spec.effect !== 'read' && spec.principal !== 'owner')
            .map(([name]) => name)
            .filter((name) => !capabilityGatedExemptions.has(name));
        expect(unaccounted).toEqual([]);
    });

    it('keeps exemptions free of Agent-reachable capabilities', () => {
        for (const [name, spec] of botMethods)
            if (capabilityGatedExemptions.has(name))
                expect(
                    spec.requiredCapabilities.some((c) => agentReachableCapabilities.has(c)),
                ).toBe(false);
    });
});

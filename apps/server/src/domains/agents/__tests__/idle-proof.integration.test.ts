import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createTestAgentService } from '../../__tests__/create-test-domain-services';
import { CaxriDatabase } from '../../db';
import { AgentCoordinator } from '../coordinator';
import type { AgentLifecycleSignal } from '../hooks/contract';

async function fixture(provider: 'claude' | 'grok' = 'claude') {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-idle-proof-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const { terminal } = database.createSession(database.createProject(directory).id, provider);
    const logger = new StructuredLogger(join(directory, 'logs'));
    const applied: AgentLifecycleSignal[] = [];
    const coordinator = new AgentCoordinator(database, createTestAgentService(), () => {}, logger, {
        onLifecycleApplied: (signal) => applied.push(signal),
    });
    onTestFinished(async () => {
        await coordinator.close();
        database.close();
        await logger.flush();
        await rm(directory, { recursive: true, force: true });
    });
    const base = {
        terminalId: terminal!.id,
        launchId: 'launch',
        provider,
        agentTurnId: 'turn',
    };
    coordinator.beginTerminalLaunch(base.terminalId, base.launchId);
    const observe = (
        phase: AgentLifecycleSignal['phase'],
        extra: Partial<AgentLifecycleSignal> = {},
    ) => coordinator.observeLifecycleSignal({ ...base, phase, ...extra });
    const isIdle = () => coordinator.hasIdleProof(base.terminalId, base.launchId, base.agentTurnId);
    return { coordinator, base, observe, isIdle, applied };
}

describe('Native Agent idle proof', () => {
    it('accepts continued Grok Stop evidence without applying completion or idle proof', async () => {
        const f = await fixture('grok');
        const identity = { agentSessionId: 'native-session' };
        expect(f.observe('sessionIdentified', identity)).toBe('accepted');
        expect(f.observe('turnStarted', identity)).toBe('accepted');
        const stop = {
            ...identity,
            agentResponseDigest: 'a'.repeat(64),
            agentResponseByteLength: 16,
        };
        expect(f.observe('turnFinished', { ...stop, agentTurnContinues: true })).toBe('accepted');
        expect(f.isIdle()).toBe(false);
        expect(f.applied.filter(({ phase }) => phase === 'turnFinished')).toHaveLength(0);
        expect(f.observe('turnFinished', stop)).toBe('accepted');
        expect(f.isIdle()).toBe(true);
        expect(f.observe('turnFinished', stop)).toBe('accepted');
        expect(f.observe('turnStarted', { ...identity, agentTurnId: 'next-turn' })).toBe(
            'accepted',
        );
        expect(f.observe('turnFinished', stop)).toBe('staleProviderTurn');
    });
    it.each(['attentionRequested', 'compactionStarted', 'turnStarted', 'subagentStarted'] as const)(
        'invalidates completed-turn proof on %s',
        async (phase) => {
            const f = await fixture();
            expect(f.isIdle()).toBe(false);
            f.observe('turnStarted');
            f.observe('turnFinished');
            expect(f.isIdle()).toBe(true);
            f.observe(phase, phase === 'subagentStarted' ? { agentId: 'child' } : {});
            expect(f.isIdle()).toBe(false);
        },
    );

    it('does not treat a deferred parent Stop or another launch as an input-ready prompt', async () => {
        const f = await fixture();
        f.observe('turnStarted');
        f.observe('subagentStarted', { agentId: 'child' });
        f.observe('turnFinished');
        expect(f.isIdle()).toBe(false);
        f.observe('turnFinished', { agentId: 'child' });
        expect(f.isIdle()).toBe(false);
        f.observe('turnStarted', { agentTurnId: 'continued' });
        expect(f.applied.at(-1)).toMatchObject({
            agentTurnId: 'continued',
            agentContinuedTurnId: 'turn',
        });
        f.observe('turnFinished', { agentTurnId: 'continued' });
        expect(f.coordinator.hasIdleProof(f.base.terminalId, 'launch', 'continued')).toBe(true);
        f.coordinator.beginTerminalLaunch(f.base.terminalId, 'new-launch');
        expect(f.coordinator.hasIdleProof(f.base.terminalId, 'launch', 'continued')).toBe(false);
        expect(f.coordinator.hasIdleProof(f.base.terminalId, 'new-launch', 'continued')).toBe(
            false,
        );
    });
});

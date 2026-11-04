import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentProvider } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { CaxriDatabase } from '../../db/repository';
import { AgentCoordinator } from '../coordinator';
import type { AgentAdapter } from '../service';
import { AgentService } from '../service';

const directories: string[] = [];
const loggers: StructuredLogger[] = [];

afterEach(async () => {
    await Promise.all(loggers.map((logger) => logger.flush()));
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
    directories.length = 0;
});

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-held-attention-'));
    directories.push(directory);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const created = database.createSession(database.createProject(directory).id, 'codex');
    const renameSession: AgentAdapter['renameSession'] = () => new Promise<never>(() => {});
    const snapshot: AgentAdapter['snapshot'] = () => Promise.reject(new Error('not used'));
    const adapters = Object.fromEntries(
        (['claude', 'codex', 'grok', 'antigravity'] as AgentProvider[]).map((provider) => [
            provider,
            { provider, renameSession, snapshot },
        ]),
    ) as Record<AgentProvider, AgentAdapter>;
    const logger = new StructuredLogger(join(directory, 'logs'));
    loggers.push(logger);
    const coordinator = new AgentCoordinator(
        database,
        new AgentService(undefined, adapters),
        () => {},
        logger,
    );
    const base = {
        launchId: 'launch-1',
        provider: 'codex' as const,
        terminalId: created.terminal!.id,
        agentTurnId: 'turn-1',
    };
    coordinator.beginTerminalLaunch(base.terminalId, base.launchId);
    coordinator.observeLifecycleSignal({ ...base, phase: 'turnStarted' });
    const session = () => database.getSession(created.session.id)!;
    const request = (id: string, alert?: 'quiet') => ({
        ...base,
        phase: 'attentionRequested' as const,
        agentToolUseId: id,
        ...(alert && { alert }),
    });
    const close = async () => {
        await coordinator.close();
        database.close();
    };
    return { base, close, coordinator, database, request, session };
}

describe('a held Agent Chat request', () => {
    it('leaves the Session running and read until it is raised, then alerts once', async () => {
        const f = await fixture();
        try {
            const held = f.request('req-1', 'quiet');
            f.coordinator.observeLifecycleSignal(held);

            expect(f.session()).toMatchObject({ agentActivityState: 'running', hasUnread: false });
            const generation = f.session().attentionGeneration;

            expect(f.coordinator.raiseHeldAttention(f.request('req-1'))).toBe(true);
            expect(f.session()).toMatchObject({
                agentActivityState: 'waiting',
                hasUnread: true,
                lastAttentionKind: 'waiting',
            });
            expect(f.session().attentionGeneration).toBe(generation + 1);

            expect(f.coordinator.raiseHeldAttention(f.request('req-1'))).toBe(true);
            expect(f.session().attentionGeneration).toBe(generation + 1);
        } finally {
            await f.close();
        }
    });

    it('alerts when the request is released before its quiet signal is applied', async () => {
        const f = await fixture();
        try {
            expect(f.coordinator.raiseHeldAttention(f.request('req-1'))).toBe(false);
            f.coordinator.observeLifecycleSignal(f.request('req-1', 'quiet'));

            expect(f.session()).toMatchObject({
                agentActivityState: 'waiting',
                hasUnread: true,
            });
        } finally {
            await f.close();
        }
    });

    it('never alerts for a request that was resolved while held', async () => {
        const f = await fixture();
        try {
            f.coordinator.observeLifecycleSignal(f.request('req-1', 'quiet'));
            f.coordinator.observeLifecycleSignal({
                ...f.base,
                phase: 'attentionResolved',
                agentToolUseId: 'req-1',
            });
            const before = f.session();

            expect(f.coordinator.raiseHeldAttention(f.request('req-1'))).toBe(false);
            expect(f.session()).toEqual(before);
        } finally {
            await f.close();
        }
    });

    it('still alerts when an earlier waiting alert was already read', async () => {
        const f = await fixture();
        try {
            f.coordinator.observeLifecycleSignal(f.request('req-0'));
            expect(f.session().agentActivityState).toBe('waiting');
            f.database.markSessionAttentionRead(f.session().id, f.session().attentionGeneration);
            expect(f.session().hasUnread).toBe(false);

            f.coordinator.observeLifecycleSignal(f.request('req-1', 'quiet'));
            expect(f.session().hasUnread).toBe(false);
            const generation = f.session().attentionGeneration;

            expect(f.coordinator.raiseHeldAttention(f.request('req-1'))).toBe(true);
            expect(f.session()).toMatchObject({ agentActivityState: 'waiting', hasUnread: true });
            expect(f.session().attentionGeneration).toBe(generation + 1);
        } finally {
            await f.close();
        }
    });

    it('does not alert a second time when the Session already shows an unread waiting alert', async () => {
        const f = await fixture();
        try {
            f.coordinator.observeLifecycleSignal(f.request('req-0'));
            const generation = f.session().attentionGeneration;
            f.coordinator.observeLifecycleSignal(f.request('req-1', 'quiet'));

            expect(f.coordinator.raiseHeldAttention(f.request('req-1'))).toBe(true);
            expect(f.session().attentionGeneration).toBe(generation);
        } finally {
            await f.close();
        }
    });
});

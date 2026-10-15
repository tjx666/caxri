import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

describe('Agent Chat idle maintenance', () => {
    it('stops an idle bound Chat, keeps its conversation, and resumes the same thread on selection', async () => {
        const { database, service, spawnProcess, terminal, threadOpens, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');
        // Unbound: there is no conversation to resume yet, so suspension would only lose the draft.
        expect(service.isSuspendable(terminal.id)).toBe(false);

        await service.send(terminal.id, { text: 'hi there' });
        await until(
            (snapshot) => snapshot.turns.at(-1)?.status === 'completed' && !snapshot.activeTurnId,
        );
        const threadId = database.getTerminal(terminal.id)?.agentSessionId;
        expect(service.isSuspendable(terminal.id)).toBe(true);

        expect(await service.suspendIdle(terminal.id)).toMatchObject({
            lastProcessState: 'suspended',
            lastAgentProcessState: 'suspended',
        });
        expect(service.liveCount()).toBe(0);
        const parked = await until((snapshot) => snapshot.status === 'stopped');
        expect(parked.items.at(-1)).toMatchObject({ type: 'agentMessage' });

        service.resumeSuspended(terminal.sessionId);
        await until((snapshot) => snapshot.status === 'ready');
        expect(spawnProcess).toHaveBeenCalledTimes(2);
        expect(database.getTerminal(terminal.id)?.lastProcessState).toBe('running');
        expect((await threadOpens()).at(-1)).toMatchObject({ method: 'thread/resume' });
        expect(database.getTerminal(terminal.id)?.agentSessionId).toBe(threadId);

        // The resumed launch is no longer suspending: an archive's stop records `stopped`, not `suspended`.
        await service.closeSession(terminal.sessionId);
        expect(database.getTerminal(terminal.id)?.lastProcessState).toBe('stopped');
    });

    it('never stops a Chat inside a turn', async () => {
        const { service, terminal, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');
        await service.send(terminal.id, { text: 'hi there' });
        await until(
            (snapshot) => snapshot.turns.at(-1)?.status === 'completed' && !snapshot.activeTurnId,
        );
        await service.send(terminal.id, { text: 'slow reply please' });
        await until((snapshot) => snapshot.activeTurnId !== undefined);

        expect(service.isSuspendable(terminal.id)).toBe(false);
    });

    it.each(['claude', 'codex', 'grok'] as const)(
        'does not report %s compaction as a new user task',
        async (provider) => {
            const { service, signals, terminal, until } = await fixture({ provider });
            await until((snapshot) => snapshot.status === 'ready');
            await service.send(terminal.id, { text: 'hello before maintenance' });
            await until(
                (snapshot) =>
                    snapshot.turns.at(-1)?.status === 'completed' && !snapshot.activeTurnId,
            );
            const start = signals.length;
            await service.compactIdle(terminal.id, service.idleLaunchId(terminal.id)!);
            const compacted = await until(
                (snapshot) =>
                    snapshot.items.some(
                        (item) => item.type === 'notice' && item.kind === 'compacted',
                    ) && !snapshot.activeTurnId,
            );
            const maintenance = signals.slice(start);
            const phases = maintenance
                .filter((signal) => signal.activity !== 'maintenance')
                .map((signal) => signal.phase);
            expect(
                maintenance
                    .filter((signal) =>
                        ['turnStarted', 'turnFinished', 'turnFailed'].includes(signal.phase),
                    )
                    .every((signal) => signal.activity === 'maintenance'),
            ).toBe(true);
            expect(phases).toContain('compactionStarted');
            expect(phases).toContain('compactionFinished');
            expect(phases).not.toContain('turnStarted');
            expect(phases).not.toContain('turnFinished');
            const next = signals.length;
            await service.send(terminal.id, { text: 'hello after maintenance' });
            await until(
                (snapshot) =>
                    snapshot.turns.at(-1)?.id !== compacted.turns.at(-1)?.id &&
                    snapshot.turns.at(-1)?.status === 'completed' &&
                    !snapshot.activeTurnId,
            );
            expect(signals.slice(next).map((signal) => signal.phase)).toEqual(
                expect.arrayContaining(['turnStarted', 'turnFinished']),
            );
        },
    );

    it('compacts only the idle launch batch compaction saw', async () => {
        const { service, terminal, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');
        expect(service.idleLaunchId(terminal.id)).toBeUndefined();
        await service.send(terminal.id, { text: 'hi there' });
        await until(
            (snapshot) => snapshot.turns.at(-1)?.status === 'completed' && !snapshot.activeTurnId,
        );
        const launchId = service.idleLaunchId(terminal.id)!;
        expect(launchId).toBeTruthy();

        await expect(service.compactIdle(terminal.id, 'another-launch')).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        await service.compactIdle(terminal.id, launchId);
        const compacted = await until(
            (snapshot) =>
                snapshot.items.some((item) => 'kind' in item && item.kind === 'compacted') &&
                !snapshot.activeTurnId,
        );
        expect(compacted.turns.at(-1)?.status).toBe('completed');
    });
});

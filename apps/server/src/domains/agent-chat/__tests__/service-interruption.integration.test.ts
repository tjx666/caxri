import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

describe('Agent Chat interruption attribution', () => {
    it.each(['claude', 'codex'] as const)(
        'does not attribute a later %s process exit to a rejected Stop',
        async (provider) => {
            const { service, terminal, until, client, rejectInterrupt, spawnProcess } =
                await fixture({ provider });
            await until((snapshot) => snapshot.status === 'ready');
            await service.send(terminal.id, { text: 'slow reply please' });
            const running = await until((snapshot) =>
                snapshot.items.some((item) => item.type === 'agentMessage' && item.streaming),
            );
            await rejectInterrupt();
            await expect(service.interrupt(terminal.id)).rejects.toThrow();
            expect(client().activeTurnId).toBe(running.activeTurnId);
            const spawned = spawnProcess.mock.results.at(-1);
            if (spawned?.type !== 'return' || !spawned.value.pid)
                throw new Error('The owned fake provider did not start');
            spawned.value.kill('SIGTERM');
            const stopped = await until((snapshot) => snapshot.status === 'failed');
            expect(stopped.turns.at(-1)?.status).toBe('interrupted');
            expect(stopped.turns.at(-1)).not.toHaveProperty('interruptionReason');
        },
    );

    it.each(['claude', 'codex', 'grok'] as const)(
        'attributes only the exact %s turn stopped through Caxri',
        async (provider) => {
            const { service, terminal, until } = await fixture({ provider });
            await until((snapshot) => snapshot.status === 'ready');
            await service.send(terminal.id, { text: 'slow reply please' });
            const running = await until((snapshot) =>
                snapshot.items.some((item) => item.type === 'agentMessage' && item.streaming),
            );
            const turnId = running.activeTurnId;
            await service.interrupt(terminal.id);
            const stopped = await until(
                (snapshot) => snapshot.turns.at(-1)?.status === 'interrupted',
            );
            expect(stopped.turns.at(-1)).toMatchObject({ id: turnId, interruptionReason: 'user' });

            await service.send(terminal.id, { text: 'hello after stopping' });
            const next = await until(
                (snapshot) =>
                    snapshot.turns.at(-1)?.id !== turnId &&
                    snapshot.turns.at(-1)?.status === 'completed',
            );
            expect(next.turns.at(-1)).not.toHaveProperty('interruptionReason');
        },
    );

    it.each(['claude', 'codex', 'grok'] as const)(
        'does not attribute an unknown %s process exit to the user',
        async (provider) => {
            const { service, terminal, until } = await fixture({ provider });
            await until((snapshot) => snapshot.status === 'ready');
            await service.send(terminal.id, { text: 'crash now' });
            const stopped = await until((snapshot) => snapshot.status === 'failed');
            expect(stopped.turns.at(-1)?.status).toBe('interrupted');
            expect(stopped.turns.at(-1)).not.toHaveProperty('interruptionReason');
        },
    );
});

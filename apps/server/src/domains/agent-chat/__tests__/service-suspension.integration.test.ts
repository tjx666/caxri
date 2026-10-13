import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

describe('Agent Chat idle suspension', () => {
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
});

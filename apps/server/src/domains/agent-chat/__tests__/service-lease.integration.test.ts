import { describe, expect, it, vi } from 'vitest';

import { fixture } from './chat-service-fixture';

/**
 * A bound Chat as a Server Core restart leaves it: the conversation exists at the provider and nothing is running.
 */
async function stoppedBoundChat() {
    const chat = await fixture();
    await chat.until((snapshot) => snapshot.status === 'ready');
    await chat.service.send(chat.terminal.id, { text: 'hi there' });
    await chat.until(
        (snapshot) => snapshot.turns.at(-1)?.status === 'completed' && !snapshot.activeTurnId,
    );
    const agentSessionId = chat.database.getTerminal(chat.terminal.id)?.agentSessionId;
    const restarted = await chat.restartServer();
    return { ...chat, agentSessionId, service: restarted };
}

describe('Agent Chat observation lease', () => {
    it('puts a provider that only a read started on a lease, reclaims it, and reopens the same conversation', async () => {
        const { agentSessionId, database, service, spawnProcess, terminal, threadOpens } =
            await stoppedBoundChat();
        const spawnsBefore = spawnProcess.mock.calls.length;
        expect(service.readLeaseAt(terminal.id)).toBeUndefined();

        service.read(terminal.id);
        expect(service.readLeaseAt(terminal.id)).toBeDefined();
        await vi.waitFor(() => expect(service.read(terminal.id).status).toBe('ready'));
        expect(service.liveCount()).toBe(1);

        expect(await service.suspendIdle(terminal.id, 'observation')).toMatchObject({
            lastProcessState: 'suspended',
        });
        expect(service.liveCount()).toBe(0);
        const parked = service.read(terminal.id);
        expect(parked.items.length).toBeGreaterThan(0);

        await vi.waitFor(() => expect(service.read(terminal.id).status).toBe('ready'));
        expect(spawnProcess.mock.calls.length).toBe(spawnsBefore + 2);
        expect(database.getTerminal(terminal.id)?.agentSessionId).toBe(agentSessionId);
        expect((await threadOpens()).at(-1)).toMatchObject({ method: 'thread/resume' });
        expect(service.read(terminal.id).items.length).toBe(parked.items.length);
    });

    it('ends the lease when input arrives, so a reclaim decided before it leaves the Chat running', async () => {
        const { service, terminal } = await stoppedBoundChat();
        service.read(terminal.id);
        await vi.waitFor(() => expect(service.read(terminal.id).status).toBe('ready'));

        await service.send(terminal.id, { text: 'hi there again' });
        expect(service.readLeaseAt(terminal.id)).toBeUndefined();
        await vi.waitFor(() => expect(service.read(terminal.id).activeTurnId).toBeUndefined());

        expect(await service.suspendIdle(terminal.id, 'observation')).toBeUndefined();
        expect(service.liveCount()).toBe(1);
    });

    it('settles to one provider on the same conversation when a read lands while its reclaim is in flight', async () => {
        const { agentSessionId, database, service, terminal } = await stoppedBoundChat();
        service.read(terminal.id);
        await vi.waitFor(() => expect(service.read(terminal.id).status).toBe('ready'));
        const items = service.read(terminal.id).items.length;

        const reclaim = service.suspendIdle(terminal.id, 'observation');
        // The user reopens the Chat before the provider has exited.
        service.read(terminal.id);
        await reclaim;
        expect(service.liveCount()).toBeLessThanOrEqual(1);

        await vi.waitFor(() => expect(service.read(terminal.id).status).toBe('ready'));
        expect(service.liveCount()).toBe(1);
        expect(database.getTerminal(terminal.id)?.agentSessionId).toBe(agentSessionId);
        expect(service.read(terminal.id).items.length).toBe(items);
    });

    it('resumes a reclaimed Chat exactly once when its Session is reselected during the reclaim', async () => {
        const { agentSessionId, database, service, spawnProcess, terminal } =
            await stoppedBoundChat();
        service.read(terminal.id);
        await vi.waitFor(() => expect(service.read(terminal.id).status).toBe('ready'));
        const spawnsBefore = spawnProcess.mock.calls.length;

        const reclaim = service.suspendIdle(terminal.id, 'observation');
        // A reselection that lands mid-reclaim sees a provider still attached and leaves it alone...
        service.resumeSuspended(terminal.sessionId);
        expect(await reclaim).toMatchObject({ lastProcessState: 'suspended' });
        // ...and the suspension fence's restore after the reclaim (`onSuspendedSessionReselected`) starts it once.
        service.resumeSuspended(terminal.sessionId);
        service.resumeSuspended(terminal.sessionId);

        await vi.waitFor(() => expect(service.read(terminal.id).status).toBe('ready'));
        expect(spawnProcess.mock.calls.length).toBe(spawnsBefore + 1);
        expect(service.liveCount()).toBe(1);
        expect(database.getTerminal(terminal.id)?.agentSessionId).toBe(agentSessionId);
    });

    it('reclaims a new Chat that was opened and left without a message, and starts it fresh on the next read', async () => {
        const { database, service, spawnProcess, terminal, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');
        expect(service.readLeaseAt(terminal.id)).toBeDefined();

        expect(await service.suspendIdle(terminal.id, 'observation')).toMatchObject({
            lastProcessState: 'suspended',
        });
        expect(service.liveCount()).toBe(0);
        expect(database.getTerminal(terminal.id)?.agentSessionId).toBeUndefined();

        await vi.waitFor(() => expect(service.read(terminal.id).status).toBe('ready'));
        expect(spawnProcess).toHaveBeenCalledTimes(2);
        await service.send(terminal.id, { text: 'hi there' });
        await until(
            (snapshot) => snapshot.turns.at(-1)?.status === 'completed' && !snapshot.activeTurnId,
        );
        expect(database.getTerminal(terminal.id)?.agentSessionId).toBeDefined();
    });

    it('keeps a new Chat running once input such as a model switch ends its lease', async () => {
        const { service, terminal, until } = await fixture();
        await until((snapshot) => snapshot.status === 'ready');

        await service.configure(terminal.id, { effort: 'high' });
        expect(service.readLeaseAt(terminal.id)).toBeUndefined();
        expect(service.isSuspendable(terminal.id)).toBe(false);
        expect(await service.suspendIdle(terminal.id, 'idle')).toBeUndefined();
        expect(service.liveCount()).toBe(1);
    });
});

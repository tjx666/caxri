import { describe, expect, it, vi } from 'vitest';

import { MAX_TERMINALS_GLOBAL, MAX_TERMINALS_PER_SESSION } from '../../db/terminal-capacity';
import { fixture } from './chat-service-fixture';

type ChatFixture = Awaited<ReturnType<typeof fixture>>;

/**
 * Leaves the fixture's Chat stopped (it owns no process, so it does not count) and fills the Session or the whole
 * database with live shell Terminals up to the limit.
 */
function fillCapacity({ database, service, terminal }: ChatFixture, scope: 'session' | 'global') {
    database.updateTerminalState(terminal.id, 'stopped');
    database.updateAgentProcessState(terminal.id, 'stopped');
    const project = database.getSession(terminal.sessionId)!.projectId;
    let sessionId = terminal.sessionId;
    let created = 0;
    const limit = scope === 'session' ? MAX_TERMINALS_PER_SESSION : MAX_TERMINALS_GLOBAL;
    while (created < limit) {
        if (created > 0 && created % MAX_TERMINALS_PER_SESSION === 0)
            sessionId = database.createSession(project, null).session.id;
        database.createTerminal(sessionId, 'shell', '/tmp');
        created += 1;
    }
    expect(service.liveCount()).toBe(0);
}

describe('Agent Chat provider capacity', () => {
    it.each(['session', 'global'] as const)(
        'refuses to start a stopped Chat from a read or a send at the %s Terminal limit',
        async (scope) => {
            const chat = await fixture();
            fillCapacity(chat, scope);
            const { database, service, spawnProcess, terminal } = chat;

            service.read(terminal.id);
            await expect(service.send(terminal.id, { text: 'hello' })).rejects.toMatchObject({
                code: 'CAPACITY',
            });
            await expect(service.start(terminal.id)).resolves.toBeUndefined();
            await expect(service.restart(terminal.id)).resolves.toBeDefined();

            expect(spawnProcess).not.toHaveBeenCalled();
            expect(service.liveCount()).toBe(0);
            expect(database.getTerminal(terminal.id)?.lastProcessState).toBe('stopped');
        },
    );
    it.each(['session', 'global'] as const)(
        'refuses to resume a suspended Chat on reselection at the %s Terminal limit',
        async (scope) => {
            const chat = await fixture();
            fillCapacity(chat, scope);
            const { database, service, spawnProcess, terminal } = chat;
            service.read(terminal.id);
            database.updateAgentProcessState(terminal.id, 'suspended');

            service.resumeSuspended(terminal.sessionId);
            await vi.waitFor(() =>
                expect(database.getTerminal(terminal.id)?.lastProcessState).not.toBe('starting'),
            );

            expect(spawnProcess).not.toHaveBeenCalled();
            expect(service.liveCount()).toBe(0);
        },
    );
});

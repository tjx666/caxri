import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CommanderHandoverService } from '../handover';
import { commanderHandoverAccess, commanderHandovers } from '../handover-records';
import { fixture } from './handover.fixture';

describe('explicit Commander Stop ownership', () => {
    it('returns pending and continued hand-overs while preserving tasks, running Agents and created Sessions', async () => {
        const f = await fixture();
        const pending = f.agentSession('pending');
        const continued = f.agentSession('continued');
        const created = f.database.createSession(f.userProject.id, 'shell').session;
        const rows = f.database.agentCommanderRows()!;
        f.database.setAppState('agentCommander', { ...rows, sessionIds: [created.id] });
        const result = await f.service.handOver({
            sessionIds: [pending.session.id, continued.session.id],
        });
        const [first, second] = result.outcomes;
        if (
            first.outcome !== 'accepted' ||
            second.outcome !== 'accepted' ||
            !first.taskId ||
            !second.taskId
        )
            throw new Error('Hand-over refused');
        commanderHandoverAccess(f.database).consume(second.handoverId, 'delegation-1');
        const taskBefore = f.database.commanderTasks.get(second.taskId);
        expect(taskBefore).toMatchObject({ status: 'dispatched', delegationId: 'delegation-1' });
        f.database.updateTerminalState(continued.terminal.id, 'running');
        const before = f.database.getTerminal(continued.terminal.id);

        expect(await f.service.returnAllForStop()).toBe(2);
        expect(f.service.managedSessions().sessionIds).toEqual([created.id]);
        expect(commanderHandovers(f.database)).toEqual([]);
        expect(f.database.commanderTasks.get(first.taskId)?.status).toBe('dropped');
        expect(f.database.commanderTasks.get(second.taskId)).toEqual(taskBefore);
        expect(f.database.getTerminal(continued.terminal.id)).toEqual(before);
        expect(await f.service.returnAllForStop()).toBe(0);
        expect(() =>
            commanderHandoverAccess(f.database).target(second.handoverId, continued.session.id),
        ).toThrow('Hand-over is unavailable');
    });

    it('returns ownership-only and cleared hand-overs without re-announcing either', async () => {
        const f = await fixture();
        const cleared = f.agentSession();
        await f.service.handOver({ sessionIds: [cleared.session.id] });
        f.database.commanderTasks.delete('all');
        f.service.forgetClearedTasks();
        const ownershipOnly = f.database.createSession(f.userProject.id, 'shell').session;
        await f.service.handOver({ sessionIds: [ownershipOnly.id] });
        f.notify.mockClear();
        expect(await f.service.returnAllForStop()).toBe(2);
        f.service.onLifecycleApplied({ terminalId: cleared.terminal.id });
        f.service.requeue();
        expect(f.notify).not.toHaveBeenCalled();
        expect(f.service.managedSessions().sessionIds).toEqual([]);
    });

    it('waits for an external hand-over already importing before returning ownership', async () => {
        const f = await fixture();
        const cwd = join(f.directory, 'external');
        await mkdir(cwd);
        const { promise: discovery, resolve: release } = Promise.withResolvers<void>();
        const service = new CommanderHandoverService({
            database: f.database,
            discoverConversations: async () => {
                await discovery;
                return [
                    {
                        provider: 'codex',
                        providerSessionId: 'external-1',
                        cwd,
                        updatedAt: 1,
                        mayBeOpen: false,
                    },
                ];
            },
            resolveProjectRoot: (path) => Promise.resolve(path),
            notify: vi.fn(),
            sendFullStateChange: vi.fn(),
        });
        const transfer = service.handOver({
            conversations: [{ provider: 'codex', providerSessionId: 'external-1' }],
        });
        const stop = service.returnAllForStop();
        release();
        expect((await transfer).outcomes[0].outcome).toBe('accepted');
        expect(await stop).toBe(1);
        expect(service.managedSessions().sessionIds).toEqual([]);
    });
});

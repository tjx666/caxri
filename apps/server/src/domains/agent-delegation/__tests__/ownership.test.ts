import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AgentDispatchService } from '../../agent-dispatch';
import { CaxriDatabase } from '../../db';
import { AgentDelegationService } from '../service';

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-ownership-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const project = database.createProject(directory);
    const { session, terminal } = database.createSession(project.id, 'claude');
    const start = vi.fn<AgentDispatchService['start']>((_id, _principal, _input, options) => {
        options?.prepared(database.createTerminal(session.id, 'claude'));
        return Promise.resolve({ status: 'running' } as Awaited<
            ReturnType<AgentDispatchService['start']>
        >);
    });
    const service = new AgentDelegationService({
        database,
        dispatch: { start },
        userDataPath: directory,
        launchSettings: () => ({ executable: 'claude', args: [] }),
        verifyLaunch: () => Promise.resolve(),
        readTranscript: vi.fn().mockResolvedValue(null),
    });
    onTestFinished(() => service.close());
    return { database, service, caller: terminal!, project, session };
}

const agent = (projectId: string, endpoint: string, generation: number) => ({
    kind: 'agent' as const,
    id: `agent:${endpoint}`,
    endpointId: endpoint,
    generation,
    projectIds: [projectId],
});

describe('delegation ownership', () => {
    /**
     * An Agent resumed in the same conversation (a Caxri restart or idle suspension) is a new Endpoint generation but
     * remembers its tasks, so it keeps reading and following them up instead of launching a second child Agent. A new
     * conversation in that Terminal remembers nothing and stays refused.
     */
    it('lets an Agent resumed in the same conversation keep its tasks, but not a new conversation', async () => {
        const f = await fixture();
        expect(f.database.rebindAgentSession(f.caller.id, 'claude', 'conversation-1')).toBe(true);
        const id = randomUUID();
        await f.service.create(
            id,
            { principal: agent(f.project.id, 'endpoint-1', 1), callerTerminalId: f.caller.id },
            {
                projectId: f.project.id,
                sessionId: f.session.id,
                provider: 'claude',
                prompt: 'Synthetic task',
            },
        );
        const resumed = {
            principal: agent(f.project.id, 'endpoint-2', 2),
            callerTerminalId: f.caller.id,
        };

        expect(f.service.status(id, resumed).delegationId).toBe(id);
        expect(f.service.list(resumed, { active: false, limit: 10 }).delegations).toHaveLength(1);

        expect(f.database.rebindAgentSession(f.caller.id, 'claude', 'conversation-2')).toBe(true);
        expect(() => f.service.status(id, resumed)).toThrow(/another Agent/u);
        expect(f.service.list(resumed, { active: false, limit: 10 }).delegations).toEqual([]);
    });
});

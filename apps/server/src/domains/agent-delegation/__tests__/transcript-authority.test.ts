import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import type { StoredAgentDelegation } from '../../db';
import { CaxriDatabase } from '../../db';
import { createDelegationHandlers } from '../handlers';
import { AgentDelegationService } from '../service';

/**
 * The transcript read goes through the real service's owner check, so only the Agent that delegated a task reads its
 * Chat, and a refused read never touches the Chat projection.
 */
it('lets only the delegating Agent read a task Chat and never reads the Chat for a refused caller', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-transcript-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const service = new AgentDelegationService({
        database,
        dispatch: { start: vi.fn() },
        userDataPath: directory,
        launchSettings: () => ({ executable: 'claude', args: [] }),
        verifyLaunch: () => Promise.resolve(),
        readTranscript: vi.fn().mockResolvedValue(null),
    });
    onTestFinished(async () => {
        service.close();
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const project = database.createProject(directory);
    const caller = database.createSession(project.id, 'claude');
    const child = database.createSession(project.id, 'claude');
    const agent = (id: string, callerTerminalId: string) => ({
        principal: {
            kind: 'agent' as const,
            id,
            endpointId: id,
            generation: 1,
            projectIds: [project.id],
        },
        callerTerminalId,
    });
    const owner = agent('caller', caller.terminal!.id);
    database.agentDelegations.insert({
        receipt: {
            delegationId: 'task-1',
            projectId: project.id,
            sessionId: child.session.id,
            provider: 'claude',
            status: 'running',
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
            terminalId: child.terminal!.id,
            callerTerminalId: owner.callerTerminalId,
        },
        principal: owner.principal,
        input: {
            projectId: project.id,
            sessionId: child.session.id,
            provider: 'claude',
            prompt: 'Synthetic task',
        },
        fingerprint: 'synthetic-fingerprint',
        promptDigest: 'a'.repeat(64),
        frozenLaunch: { executable: 'claude', args: [] },
    } satisfies StoredAgentDelegation);
    const snapshot = vi.fn(() => ({
        historyId: 'history-1',
        items: [
            {
                id: 'start',
                type: 'userMessage' as const,
                text: 'Pointer',
                delegatedTask: { delegationId: 'task-1' },
            },
        ],
    }));
    const read = createDelegationHandlers(service, database, {
        transcripts: { readChildChat: () => true, isChatTerminal: () => true, snapshot },
    })['agent.delegation.transcriptInternal'];

    expect(() =>
        read({ delegationId: 'task-1', ...agent('other', caller.terminal!.id) }, undefined),
    ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => read({ delegationId: 'missing', ...owner }, undefined)).toThrow(
        expect.objectContaining({ code: 'NOT_FOUND' }),
    );
    expect(snapshot).not.toHaveBeenCalled();

    expect(read({ delegationId: 'task-1', ...owner }, undefined)).toMatchObject({
        status: 'available',
        rows: [{ id: 'start', kind: 'task' }],
    });
    expect(database.agentDelegations.get('task-1')?.collectedAt).toBeUndefined();
});

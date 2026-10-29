import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import type { StoredAgentDelegation } from '../../db';
import { CaxriDatabase } from '../../db';
import { createDelegationHandlers } from '../handlers';
import type { AgentDelegationService } from '../service';

const authority = { principal: { kind: 'human-cli', id: 'synthetic-owner' } } as const;

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-handlers-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const { session } = database.createSession(database.createProject(directory).id, 'shell');
    const make = (id: string, status: 'completed' | 'running', hasAnswer: boolean) =>
        ({
            receipt: {
                delegationId: id,
                projectId: session.projectId,
                sessionId: session.id,
                provider: 'claude',
                status,
                revision: 1,
                createdAt: 1,
                updatedAt: 1,
            },
            principal: authority.principal,
            input: {
                projectId: session.projectId,
                sessionId: session.id,
                provider: 'claude',
                prompt: 'Synthetic task',
            },
            fingerprint: 'synthetic-fingerprint',
            promptDigest: 'a'.repeat(64),
            frozenLaunch: { executable: 'claude', args: [] },
            ...(hasAnswer && {
                answer: {
                    text: 'Synthetic answer',
                    source: 'transcript' as const,
                    messageId: 'm',
                    truncated: false,
                    byteLength: 16,
                },
            }),
        }) satisfies StoredAgentDelegation;
    const read = (id: string) => {
        const record = database.agentDelegations.get(id)!;
        return Promise.resolve({ receipt: record.receipt, answer: record.answer });
    };
    const service = {
        result: read,
        wait: async (ids: readonly string[]) => ({ ...(await read(ids[0])), outcome: 'settled' }),
    } as unknown as AgentDelegationService;
    return { database, make, handlers: createDelegationHandlers(service, database) };
}

it('claims a completed answer once wait or result returns it', async () => {
    const { database, make, handlers } = await fixture();
    for (const record of [
        make('waited', 'completed', true),
        make('resulted', 'completed', true),
        make('running', 'running', false),
    ])
        database.agentDelegations.insert(record);

    await handlers['agent.delegation.waitInternal'](
        { delegationId: 'waited', timeoutMs: 0, ...authority },
        undefined,
    );
    await handlers['agent.delegation.resultInternal'](
        { delegationId: 'resulted', ...authority },
        undefined,
    );
    await handlers['agent.delegation.resultInternal'](
        { delegationId: 'running', ...authority },
        undefined,
    );

    expect(database.agentDelegations.get('waited')?.collectedAt).toBeDefined();
    expect(database.agentDelegations.get('resulted')?.collectedAt).toBeDefined();
    expect(database.agentDelegations.get('running')?.collectedAt).toBeUndefined();
    expect(database.agentDelegations.get('waited')?.receipt.revision).toBe(1);
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionPullRequest } from '@caxri/protocol';
import { expect, it, onTestFinished, vi } from 'vitest';

import type { StoredAgentDelegation } from '../../db';
import { CaxriDatabase } from '../../db';
import { createDelegationHandlers } from '../handlers';
import type { AgentDelegationService } from '../service';

const authority = { principal: { kind: 'human-cli', id: 'synthetic-owner' } } as const;

async function fixture(pullRequest?: SessionPullRequest) {
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
    const owned = vi.fn((id: string) => database.agentDelegations.get(id));
    const service = {
        result: read,
        owned,
        wait: async (ids: readonly string[]) => ({ ...(await read(ids[0])), outcome: 'settled' }),
    } as unknown as AgentDelegationService;
    const pullRequests = { pullRequest: () => pullRequest };
    const transcripts = {
        readChildChat: () => true,
        isChatTerminal: () => true,
        snapshot: () => ({
            items: [
                {
                    id: 'start',
                    type: 'userMessage' as const,
                    text: 'Pointer',
                    delegatedTask: { delegationId: 'done' },
                },
            ],
        }),
    };
    return {
        database,
        make,
        owned,
        handlers: createDelegationHandlers(service, database, { pullRequests, transcripts }),
    };
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

const pullRequest: SessionPullRequest = {
    number: 7,
    title: 'Synthetic change',
    url: 'https://github.com/owner/example/pull/7',
    state: 'open',
    source: 'agent',
    changedFiles: 3,
};

it('returns the Session pull request with a settled task, labeled as the whole pull request', async () => {
    const { database, make, handlers } = await fixture(pullRequest);
    database.agentDelegations.insert(make('done', 'completed', true));
    database.agentDelegations.insert(make('active', 'running', false));

    const result = await handlers['agent.delegation.resultInternal'](
        { delegationId: 'done', ...authority },
        undefined,
    );
    const waited = await handlers['agent.delegation.waitInternal'](
        { delegationId: 'done', timeoutMs: 0, ...authority },
        undefined,
    );
    const running = await handlers['agent.delegation.resultInternal'](
        { delegationId: 'active', ...authority },
        undefined,
    );

    const expected = { url: pullRequest.url, number: 7, state: 'open', changedFileCount: 3 };
    expect(result.pullRequest).toStrictEqual(expected);
    expect(waited.pullRequest).toStrictEqual(expected);
    expect(running.pullRequest).toBeUndefined();
});

it('omits a file count GitHub did not report, and a pull request the Session has none of', async () => {
    const uncounted = { ...pullRequest, changedFiles: undefined };
    const counted = await fixture(uncounted);
    counted.database.agentDelegations.insert(counted.make('done', 'completed', true));
    const none = await fixture();
    none.database.agentDelegations.insert(none.make('done', 'completed', true));

    const withoutCount = await counted.handlers['agent.delegation.resultInternal'](
        { delegationId: 'done', ...authority },
        undefined,
    );
    const withoutPullRequest = await none.handlers['agent.delegation.resultInternal'](
        { delegationId: 'done', ...authority },
        undefined,
    );

    expect(withoutCount.pullRequest).toStrictEqual({
        url: pullRequest.url,
        number: 7,
        state: 'open',
    });
    expect(withoutPullRequest).not.toHaveProperty('pullRequest');
});

it('reads a delegated Chat under the owner check without marking the answer read', async () => {
    const { database, make, owned, handlers } = await fixture();
    const done = make('done', 'completed', true);
    database.agentDelegations.insert({ ...done, receipt: { ...done.receipt, terminalId: 't' } });

    const page = await handlers['agent.delegation.transcriptInternal'](
        { delegationId: 'done', ...authority },
        undefined,
    );

    expect(owned).toHaveBeenCalledWith('done', authority, 'existing');
    expect(page).toMatchObject({ status: 'available', settled: true, rows: [{ kind: 'task' }] });
    expect(database.agentDelegations.get('done')?.collectedAt).toBeUndefined();
});

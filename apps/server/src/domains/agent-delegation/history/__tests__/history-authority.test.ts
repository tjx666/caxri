import { agentDelegationHistoryMethods, internalMethods, methods } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { delegatedFixture } from '../../__tests__/delegated-sessions.fixture';
import { readHistory } from '../read';
import { historyRow } from '../row';

type Fixture = Awaited<ReturnType<typeof delegatedFixture>>;

async function settledTask(f: Fixture) {
    const task = await f.delegate();
    await f.finish(task, 'Summary: Done.');
    return task;
}

const ids = (f: Fixture, authority: Parameters<typeof readHistory>[1]) =>
    readHistory(f.database, authority, { limit: 50 }).entries.map((entry) => entry.delegationId);

describe('who reads which history rows', () => {
    it('shows an Agent only the rows its own Terminal and Endpoint generation created', async () => {
        const f = await delegatedFixture();
        const task = await settledTask(f);

        expect(ids(f, f.authority)).toEqual([task.id]);
        // Another Terminal.
        expect(ids(f, { ...f.authority, callerTerminalId: 'terminal-b' })).toEqual([]);
        // The same Terminal after a relaunch: a new Endpoint generation gets none of its predecessor's rows.
        expect(
            ids(f, {
                ...f.authority,
                principal: {
                    ...f.authority.principal,
                    generation: f.authority.principal.generation + 1,
                },
            }),
        ).toEqual([]);
    });

    it('lets Caxri Bot read its Terminal rows under any generation, exactly as for tasks', async () => {
        const f = await delegatedFixture();
        await settledTask(f);
        const bot = {
            principal: { ...f.authority.principal, generation: 9 },
            callerTerminalId: f.authority.callerTerminalId,
        };
        const stored = f.database.agentDelegations.get(
            readHistory(f.database, f.authority, { limit: 1 }).entries[0].delegationId,
        )!;
        const original = f.database.caxriBotRows.bind(f.database);
        f.database.caxriBotRows = () =>
            ({
                terminalId: bot.callerTerminalId,
                projectId: bot.principal.projectIds[0],
            }) as never;
        const withBot = ids(f, {
            ...bot,
            principal: { ...bot.principal, projectIds: [bot.principal.projectIds[0]] },
        });
        f.database.caxriBotRows = original;

        expect(stored).toBeDefined();
        expect(withBot).toHaveLength(1);
    });

    it('keeps a delegation client to its own client id and generation', async () => {
        const f = await delegatedFixture();
        const client = (clientId: string, generation: number) => ({
            kind: 'delegation-client' as const,
            id: clientId,
            clientId,
            generation,
            projectIds: [f.project.id] as [string],
            sessionId: 'session-x',
            callerProvider: 'claude' as const,
        });
        const task = await f.delegate();
        const stored = f.database.agentDelegations.get(task.id)!;
        // A client's tasks carry no Terminal, so the stored row has a NULL owner Terminal.
        const mine = client('client-a', 1);
        f.database.agentDelegations.history.record(
            {
                ...historyRow(
                    {
                        ...stored,
                        principal: mine,
                        receipt: {
                            ...stored.receipt,
                            status: 'completed',
                            callerTerminalId: undefined,
                        },
                    },
                    'Client task',
                ),
                delegationId: 'client-task',
                rootDelegationId: 'client-task',
            },
            5000,
            1,
        );

        expect(ids(f, { principal: mine })).toEqual(['client-task']);
        expect(ids(f, { principal: client('client-b', 1) })).toEqual([]);
        expect(ids(f, { principal: client('client-a', 2) })).toEqual([]);
        // The client never sees an Agent's rows, and the Agent never sees the client's.
        expect(ids(f, f.authority)).not.toContain('client-task');
    });

    it.each([
        { kind: 'human-cli' as const, id: 'owner' },
        { kind: 'desktop' as const, id: 'desktop', generation: 1 },
        {
            kind: 'extension' as const,
            id: 'extension',
            extensionId: 'extension',
            generation: 1,
            projectIds: [],
        },
        {
            kind: 'paired-device' as const,
            id: 'phone',
            deviceId: 'phone',
            generation: 1,
            role: 'full' as const,
            projectIds: [],
        },
    ])('treats $kind as an owner who sees every row', async (principal) => {
        const f = await delegatedFixture();
        const task = await settledTask(f);

        expect(ids(f, { principal } as never)).toEqual([task.id]);
    });

    it('takes no session, project, creator, terminal, or principal parameter', () => {
        const { params } = methods['agent.delegation.history'];
        for (const foreign of [
            'sessionId',
            'projectId',
            'createdBySessionId',
            'terminalId',
            'principal',
        ])
            expect(params.safeParse({ [foreign]: 'x' }).success).toBe(false);
        expect(params.parse({}).limit).toBe(20);
        expect(params.safeParse({ limit: 51 }).success).toBe(false);
        expect(params.safeParse({ query: '' }).success).toBe(false);
        expect(params.safeParse({ query: 'a\u{0}b' }).success).toBe(false);
        expect(params.safeParse({ outcome: 'running' }).success).toBe(false);
    });

    it('cannot let the Internal twin override its authority from the params', () => {
        const parsed = internalMethods['agent.delegation.historyInternal'].params.safeParse({
            principal: { kind: 'human-cli', id: 'owner' },
            callerTerminalId: 'terminal-1',
            sessionId: 'session-1',
        });

        expect(parsed.success).toBe(false);
    });

    it('registers the public and the Internal method in separate maps only', () => {
        expect(Object.keys(agentDelegationHistoryMethods)).toEqual(['agent.delegation.history']);
        expect(methods).toHaveProperty(['agent.delegation.history']);
        expect(methods).not.toHaveProperty(['agent.delegation.historyInternal']);
        expect(internalMethods).toHaveProperty(['agent.delegation.historyInternal']);
        expect(internalMethods).not.toHaveProperty(['agent.delegation.history']);
        expect(methods['agent.delegation.history'].requiredCapabilities).toEqual([
            'agents.delegate',
        ]);
    });
});

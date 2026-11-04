import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Principal } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { authorizeDelegationSession } from '../admission';
import { newSessionFixture } from './new-session.fixture';

/**
 * An external client (an Agent running outside Caxri) anchored on the shared dedicated Session of the caller Project
 * and provider, delegating into the work Project. The anchor is shared: two clients of one Project and provider get the
 * same Session, so only the exact principal tells their children apart.
 */
async function externalFixture() {
    const f = await newSessionFixture();
    const anchor = f.database.ensureDelegationContext(join(f.directory, 'caller'), 'claude', false);
    const client = (clientId: string, generation = 1) => ({
        principal: {
            kind: 'delegation-client' as const,
            id: `external-${clientId}-${generation}`,
            clientId,
            generation,
            projectIds: [anchor.projectId] as [string],
            sessionId: anchor.sessionId,
            callerProvider: 'claude' as const,
        },
    });
    return { ...f, anchor, client };
}

describe('Delegation lineage of an external client', () => {
    it('titles the shared anchor Session after the provider and reuses it for a second client', async () => {
        const { database, anchor } = await externalFixture();

        expect(database.getSession(anchor.sessionId)?.title).toBe('External Claude');
        expect(
            database.ensureDelegationContext(
                database.getProject(anchor.projectId)!.rootPath,
                'claude',
                false,
            ).sessionId,
        ).toBe(anchor.sessionId);
        expect(database.listSessions(anchor.projectId)).toHaveLength(2);
    });

    it('creates a Session in another Project that nests under the anchor as a delegated child', async () => {
        const { database, service, anchor, client, project, request } = await externalFixture();

        const receipt = await service.create(randomUUID(), client('one'), request);

        expect(receipt.projectId).toBe(project.id);
        expect(receipt.sessionId).not.toBe(anchor.sessionId);
        expect(database.getSession(receipt.sessionId)).toMatchObject({
            createdBySessionId: anchor.sessionId,
            createdByRelation: 'delegated',
        });
        expect(receipt.callerTerminalId).toBeUndefined();
    });

    it('keeps the anchor shared but the children private to the exact client and generation', async () => {
        const { service, client, request } = await externalFixture();
        const first = await service.create(randomUUID(), client('one'), request);

        // The shared anchor creates no ownership: another client or a later generation cannot join the child.
        await Promise.all(
            [client('two'), client('one', 2)].map(async (other) => {
                await expect(
                    service.create(randomUUID(), other, {
                        projectId: first.projectId,
                        sessionId: first.sessionId,
                        provider: 'claude',
                        prompt: 'Synthetic private task',
                    }),
                ).rejects.toMatchObject({ code: 'FORBIDDEN' });
                expect(() => service.status(first.delegationId, other)).toThrow('another Agent');
            }),
        );

        // The creating client keeps using its own child Session, and sees its task.
        const again = await service.create(randomUUID(), client('one'), {
            projectId: first.projectId,
            sessionId: first.sessionId,
            provider: 'claude',
            prompt: 'Synthetic private task',
        });
        expect(again.sessionId).toBe(first.sessionId);
        expect(service.status(first.delegationId, client('one'))).toMatchObject({
            delegationId: first.delegationId,
        });
        expect(service.list(client('two'), { active: false, limit: 10 }).delegations).toEqual([]);
    });

    it('admits a Session its anchor created only on this request or with a recorded task of the exact principal', async () => {
        const { database, anchor, client, project } = await externalFixture();
        const child = database.createSession(project.id, null, undefined, {
            createdBySessionId: anchor.sessionId,
            createdByRelation: 'delegated',
        }).session;
        const target = { projectId: project.id, sessionId: child.id };
        const { principal } = client('one');
        const authorize = (isNewSession: boolean, as: Principal = principal) =>
            authorizeDelegationSession(database, { principal: as }, target, 'create', isNewSession);

        // No record proves this principal created the Session (its task was pruned, or another client made it).
        expect(() => authorize(false)).toThrow('Session it created');
        expect(() => authorize(true)).not.toThrow();
        // Reading an existing task needs only the creator edge; task ownership still decides whose it is.
        expect(() =>
            authorizeDelegationSession(database, { principal }, target, 'existing'),
        ).not.toThrow();
        // The user's own Session in the same Project is never reachable.
        const users = database.createSession(project.id, null).session;
        expect(() =>
            authorizeDelegationSession(
                database,
                { principal },
                { projectId: project.id, sessionId: users.id },
                'create',
                true,
            ),
        ).toThrow('Session it created');
    });

    it('refuses a hidden or nested Project before creating a Session', async () => {
        const { database, service, client, project, request, directory } = await externalFixture();
        const sessionsBefore = database.listVisibleSessions().length;
        const nestedRoot = join(directory, 'nested');
        await mkdir(nestedRoot);
        const nested = database.createProject(nestedRoot, project.id);
        database.hideProject(project.id);

        await Promise.all(
            [project.id, nested.id].map((projectId) =>
                expect(
                    service.create(randomUUID(), client('one'), { ...request, projectId }),
                ).rejects.toMatchObject({ code: 'FORBIDDEN' }),
            ),
        );

        expect(database.listVisibleSessions()).toHaveLength(sessionsBefore);
    });

    it('never adds a Project or a worktree for an external client', async () => {
        const { database, service, client, request } = await externalFixture();
        const projectsBefore = database.listProjects().length;

        await expect(
            service.create(randomUUID(), client('one'), { ...request, worktreeBranch: 'topic' }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });

        expect(database.listProjects()).toHaveLength(projectsBefore);
    });

    it('counts four active or pending tasks per client across Projects and Sessions', async () => {
        const { service, client, project, anchor, request } = await externalFixture();
        const toAnchorProject = { ...request, projectId: anchor.projectId };
        // One at a time, so each admission settles before the next one is counted.
        const created = [
            await service.create(randomUUID(), client('one'), request),
            await service.create(randomUUID(), client('one'), request),
            await service.create(randomUUID(), client('one'), toAnchorProject),
            await service.create(randomUUID(), client('one'), toAnchorProject),
        ];
        expect(new Set(created.map((receipt) => receipt.projectId))).toEqual(
            new Set([project.id, anchor.projectId]),
        );
        expect(new Set(created.map((receipt) => receipt.sessionId)).size).toBe(4);

        await expect(service.create(randomUUID(), client('one'), request)).rejects.toMatchObject({
            code: 'CAPACITY',
        });
        // Another client of the same anchor, and the next generation of this one, hold their own allowance.
        await expect(service.create(randomUUID(), client('two'), request)).resolves.toBeDefined();
        await expect(
            service.create(randomUUID(), client('one', 2), request),
        ).resolves.toBeDefined();
    });

    it('counts admissions still in flight against the same allowance', async () => {
        const { service, client, request } = await externalFixture();

        const settled = await Promise.allSettled(
            Array.from({ length: 6 }, () => service.create(randomUUID(), client('one'), request)),
        );

        expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(4);
        expect(
            settled.filter(
                (result) =>
                    result.status === 'rejected' &&
                    (result.reason as { code?: string }).code === 'CAPACITY',
            ),
        ).toHaveLength(2);
    });
});

/**
 * A client reaches an existing Session of the database through `CaxriDatabase`; this guards the proof query itself.
 */
describe('Proof of a delegation client task', () => {
    it('lists the principals that recorded a task in a Session', async () => {
        const { database, service, client, request } = await externalFixture();
        const receipt = await service.create(randomUUID(), client('one'), request);

        const principals = database.agentDelegations.principalsForSession(receipt.sessionId);

        expect(principals).toEqual([client('one').principal]);
    });
});

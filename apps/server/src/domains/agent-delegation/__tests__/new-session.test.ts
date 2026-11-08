import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { DelegationType } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { newSessionFixture as fixture } from './new-session.fixture';

/**
 * Caxri Bot used to create an empty Session in one command and delegate into it in the next, so the Workbench showed an
 * empty Session for as long as Caxri Bot took to write that second command.
 */
describe('Delegation into a new Session for Caxri Bot', () => {
    it('creates the Session together with its task, and a retry reuses it', async () => {
        const { database, service, botAuthority, botSessionId, request } = await fixture();
        const id = randomUUID();

        const receipt = await service.create(id, botAuthority, request);

        expect(database.caxriBotRows()?.sessionIds).toEqual([receipt.sessionId]);
        expect(database.listTerminals(receipt.sessionId)).toHaveLength(1);
        expect(database.getSession(receipt.sessionId)?.createdBySessionId).toBe(botSessionId);
        // Caxri Bot names its Session as the creator but starts no delegated, hand-off, or consult relation.
        expect(database.getSession(receipt.sessionId)).not.toHaveProperty('createdByRelation');
        // The task file pointer is all automatic naming would see, so Caxri Bot's title is kept as a manual one.
        expect(database.getSession(receipt.sessionId)).toMatchObject({
            title: 'Fix login retry',
            titleMode: 'manual',
        });
        expect((await service.create(id, botAuthority, request)).sessionId).toBe(receipt.sessionId);
    });

    it('leaves the Summary instruction out of its task, whose result is never stored', async () => {
        const { directory, service, botAuthority, request } = await fixture();
        const id = randomUUID();

        await service.create(id, botAuthority, request);

        expect(await readFile(join(directory, 'delegations', id, 'task.md'), 'utf8')).toBe(
            'Synthetic private task',
        );
    });

    it('removes the Session a concurrent retry created when both join one task', async () => {
        const { database, service, botAuthority, request } = await fixture();
        const id = randomUUID();

        const [first, second] = await Promise.all([
            service.create(id, botAuthority, request),
            service.create(id, botAuthority, request),
        ]);

        expect(second.sessionId).toBe(first.sessionId);
        expect(database.caxriBotRows()?.sessionIds).toEqual([first.sessionId]);
    });

    it('removes the Session again when admission refuses the task', async () => {
        const { database, service, botAuthority, request } = await fixture();
        const sessionsBefore = database.listVisibleSessions().length;

        await expect(
            service.create(randomUUID(), botAuthority, {
                ...request,
                provider: undefined,
                preset: 'missing-preset',
            }),
        ).rejects.toThrow();

        expect(database.listVisibleSessions()).toHaveLength(sessionsBefore);
        expect(database.caxriBotRows()?.sessionIds).toEqual([]);
    });
});

/**
 * Creating and talking to Sessions is ordinary Agent work, not a Caxri Bot privilege: an Agent in any Session, Terminal
 * or Chat, used to be refused here, and was steered toward borrowing the owner's identity instead.
 */
describe('Delegation into a new Session from an ordinary Agent', () => {
    /**
     * An Agent drafts its task file in English and then titled the Session `Delegated task: …` in English, which read
     * as the odd row out in a sidebar the user speaks Chinese in.
     */
    it("refuses a title outside the language of the caller's own Session title", async () => {
        const { database, service, agentAuthority, callerSessionId, request } = await fixture();
        database.renameSession(callerSessionId, '优化子模块的 CI 耗时');
        const before = database.listSessions().length;

        await expect(
            service.create(randomUUID(), agentAuthority, {
                ...request,
                title: 'Delegated task: schema, migration and trigger tests',
            }),
        ).rejects.toThrow('Write the Session title in Chinese');
        expect(database.listSessions()).toHaveLength(before);

        const receipt = await service.create(randomUUID(), agentAuthority, {
            ...request,
            title: '补充 schema 迁移与触发器测试',
        });
        expect(database.getSession(receipt.sessionId)?.title).toBe('补充 schema 迁移与触发器测试');
    });

    it('runs the new Session in a worktree grouped under its Project', async () => {
        const { database, service, agentAuthority, project, request, directory } = await fixture();
        await mkdir(join(directory, 'wt-feat'));

        const receipt = await service.create(randomUUID(), agentAuthority, {
            ...request,
            worktreeBranch: 'feat',
        });

        const session = database.getSession(receipt.sessionId)!;
        const worktree = database.findProjectByRootPath(join(directory, 'wt-feat'))!;
        expect(session.projectId).toBe(project.id);
        expect(session.workbenchRootProjectId).toBe(worktree.id);
    });

    it('leaves no Session behind when the worktree cannot be created', async () => {
        const { database, service, agentAuthority, request } = await fixture();
        const before = database.listSessions().length;

        await expect(
            service.create(randomUUID(), agentAuthority, { ...request, worktreeBranch: 'refused' }),
        ).rejects.toThrow('git refused');

        expect(database.listSessions()).toHaveLength(before);
    });

    it('creates a visible Session in another added Project and keeps working there', async () => {
        const { database, service, agentAuthority, callerSessionId, project, request } =
            await fixture();

        const receipt = await service.create(randomUUID(), agentAuthority, request);

        expect(database.getSession(receipt.sessionId)).toMatchObject({
            projectId: project.id,
            title: 'Fix login retry',
            createdBySessionId: callerSessionId,
        });
        // A plain user-visible Session: Caxri Bot never records it as its own.
        expect(database.listVisibleSessions().map(({ id }) => id)).toContain(receipt.sessionId);
        expect(database.caxriBotRows()?.sessionIds).toEqual([]);
        // The Agent's own task there admits its next one, without a new Session.
        const second = await service.create(randomUUID(), agentAuthority, {
            projectId: project.id,
            sessionId: receipt.sessionId,
            provider: 'claude',
            prompt: 'Second synthetic task',
        });
        expect(second.sessionId).toBe(receipt.sessionId);
        expect(service.status(receipt.delegationId, agentAuthority)).toMatchObject({
            sessionId: receipt.sessionId,
        });
        // An Agent that lost its context recovers its own task IDs, and only its own.
        expect(
            service
                .list(agentAuthority, { active: false, limit: 1 })
                .delegations.map(({ delegationId }) => delegationId),
        ).toEqual([second.delegationId]);
        expect(service.list(agentAuthority, { active: false, limit: 1 }).truncated).toBe(true);
        expect(
            service.list(
                { ...agentAuthority, principal: { ...agentAuthority.principal, generation: 2 } },
                { active: false, limit: 20 },
            ).delegations,
        ).toEqual([]);
    });

    it.each([
        { name: 'a task the caller waits on', flags: {}, relation: 'delegated' },
        { name: 'a hand-off', flags: { handoff: true as const }, relation: 'handoff' },
        { name: 'a consult', flags: { consult: true as const }, relation: 'consult' },
        {
            name: 'an independent Session',
            flags: { independent: true as const },
            relation: 'independent',
        },
    ])(
        'records $name as the $relation relation of the new Session',
        async ({ flags, relation }) => {
            const { database, service, agentAuthority, callerSessionId, request } = await fixture();

            const receipt = await service.create(randomUUID(), agentAuthority, {
                ...request,
                ...flags,
            });

            expect(database.getSession(receipt.sessionId)).toMatchObject({
                createdBySessionId: callerSessionId,
                createdByRelation: relation,
            });
        },
    );

    it('records no relation for the owner, who has no creating Session', async () => {
        const { database, service, request } = await fixture();
        const owner = { principal: { kind: 'human-cli' as const, id: 'owner', generation: 1 } };

        const receipt = await service.create(randomUUID(), owner, {
            ...request,
            consult: true as const,
        });

        const session = database.getSession(receipt.sessionId);
        expect(session).not.toHaveProperty('createdBySessionId');
        expect(session).not.toHaveProperty('createdByRelation');
    });

    it('keeps a retry on the relation its first attempt recorded', async () => {
        const { database, service, agentAuthority, request } = await fixture();
        const id = randomUUID();
        const consult = { ...request, consult: true as const };

        const receipt = await service.create(id, agentAuthority, consult);
        const retried = await service.create(id, agentAuthority, consult);

        expect(retried.sessionId).toBe(receipt.sessionId);
        expect(database.getSession(receipt.sessionId)?.createdByRelation).toBe('consult');
    });

    it('admits another Agent of the creating Session, which never delegated there itself', async () => {
        const { database, service, agentAuthority, callerSessionId, project, request } =
            await fixture();
        const receipt = await service.create(randomUUID(), agentAuthority, request);
        const sibling = database.createTerminal(callerSessionId, 'claude');

        const followUp = await service.create(
            randomUUID(),
            { ...agentAuthority, callerTerminalId: sibling.id },
            {
                projectId: project.id,
                sessionId: receipt.sessionId,
                provider: 'claude',
                prompt: 'Sibling synthetic task',
            },
        );

        expect(followUp.sessionId).toBe(receipt.sessionId);
    });

    it('refuses a Session the Agent did not create, and a hidden Project', async () => {
        const { database, service, agentAuthority, project, request } = await fixture();
        const userSession = database.createSession(project.id, null);

        await expect(
            service.create(randomUUID(), agentAuthority, {
                projectId: project.id,
                sessionId: userSession.session.id,
                provider: 'claude',
                prompt: 'Synthetic private task',
            }),
        ).rejects.toThrow('its own Session or a Session it created');
        database.hideProject(project.id);
        const sessionsBefore = database.listVisibleSessions().length;
        await expect(service.create(randomUUID(), agentAuthority, request)).rejects.toThrow(
            'Project is unavailable',
        );
        expect(database.listVisibleSessions()).toHaveLength(sessionsBefore);
    });

    it('removes the Session again when admission refuses the task', async () => {
        const { database, service, agentAuthority, request } = await fixture();
        const sessionsBefore = database.listSessions().length;

        await expect(
            service.create(randomUUID(), agentAuthority, {
                ...request,
                provider: undefined,
                preset: 'missing-preset',
            }),
        ).rejects.toThrow();

        expect(database.listSessions()).toHaveLength(sessionsBefore);
    });
});

/**
 * `agentChat.continueInAgent`: the owner, through a Client, continues a Chat's work in another Agent (issue #2581).
 */
describe('Delegation into a new Session from a Client continuation', () => {
    it('creates the Session under the continued Chat and resolves a retry to it', async () => {
        const { database, service, callerSessionId, callerTerminalId, request } = await fixture();
        const authority = {
            principal: { kind: 'desktop' as const, id: 'usage-continuation', generation: 1 },
            callerTerminalId,
        };
        const id = randomUUID();
        const continuation = { ...request, handoff: true as const, title: 'Continued: Fix login' };

        const receipt = await service.create(id, authority, continuation);
        expect(database.getSession(receipt.sessionId)).toMatchObject({
            title: 'Continued: Fix login',
            createdBySessionId: callerSessionId,
            createdByRelation: 'handoff',
        });
        expect(receipt.callerTerminalId).toBe(callerTerminalId);
        const retried = await service.create(id, authority, continuation);
        expect(retried.sessionId).toBe(receipt.sessionId);
    });
});

/**
 * `--type`: a second opinion, a review, computer use, or an X search without any preset (the dianjiang replacement).
 */
describe('Delegation of a type', () => {
    const typed = (type: DelegationType) => ({
        prompt: 'Synthetic private task',
        newSession: true as const,
        title: 'Check the plan',
        type,
    });

    it.each([
        { type: 'second-opinion' as const, relation: 'consult' },
        { type: 'review' as const, relation: 'consult' },
        { type: 'computer-use' as const, relation: 'consult' },
        { type: 'x-search' as const, relation: 'consult' },
    ])(
        'runs $type in the Project of the caller’s own Session as a $relation Session',
        async ({ type, relation }) => {
            const { database, service, agentAuthority, callerSessionId } = await fixture();
            const callerProjectId = database.getSession(callerSessionId)!.projectId;

            const receipt = await service.create(randomUUID(), agentAuthority, typed(type));

            expect(database.getSession(receipt.sessionId)).toMatchObject({
                projectId: callerProjectId,
                createdBySessionId: callerSessionId,
                createdByRelation: relation,
            });
            expect(receipt.selection?.type).toBe(type);
        },
    );

    it('follows the caller into its linked worktree, so a review reads the caller’s changes', async () => {
        const { directory, database, service, agentAuthority, callerSessionId } = await fixture();
        const callerProjectId = database.getSession(callerSessionId)!.projectId;
        const worktree = database.createProject(join(directory, 'caller-wt'), callerProjectId);
        database.selectWorkbenchProject(callerSessionId, worktree.id);

        const receipt = await service.create(randomUUID(), agentAuthority, typed('review'));

        expect(database.getSession(receipt.sessionId)).toMatchObject({
            projectId: callerProjectId,
            workbenchRootProjectId: worktree.id,
        });
    });

    it('asks the other vendor by default and opens the task with the type’s instructions', async () => {
        const { directory, service, agentAuthority } = await fixture();
        const id = randomUUID();

        // The fixture's caller is a Codex Session, so a review goes to Claude.
        const receipt = await service.create(id, agentAuthority, typed('review'));

        expect(receipt.selection).toEqual({
            provider: 'claude',
            model: 'sonnet',
            effort: 'xhigh',
            type: 'review',
        });
        const task = await readFile(join(directory, 'delegations', id, 'task.md'), 'utf8');
        expect(task).toMatch(/^You are asked to review code changes as an independent reviewer\./u);
        expect(task).toContain('Synthetic private task');
    });

    it('sends an X search to Grok whoever asks, opening the task with its citation rules', async () => {
        const { directory, service, agentAuthority } = await fixture();
        const id = randomUUID();

        const receipt = await service.create(id, agentAuthority, typed('x-search'));

        expect(receipt.selection).toEqual({
            provider: 'grok',
            model: 'grok-4.7',
            effort: 'medium',
            type: 'x-search',
        });
        // Grok Build's Chat cannot report a task, so the child opens on the PTY Terminal.
        expect(receipt.surface).toBe('pty');
        const task = await readFile(join(directory, 'delegations', id, 'task.md'), 'utf8');
        expect(task).toMatch(/^Use your live X \(Twitter\) search tools/u);
        expect(task).toContain('Synthetic private task');
    });

    it('runs the type on an Agent the request names, keeping its instructions', async () => {
        const { directory, service, agentAuthority } = await fixture();
        const id = randomUUID();

        const receipt = await service.create(id, agentAuthority, {
            ...typed('second-opinion'),
            provider: 'codex',
        });

        expect(receipt.selection).toEqual({ provider: 'codex', type: 'second-opinion' });
        const task = await readFile(join(directory, 'delegations', id, 'task.md'), 'utf8');
        expect(task).toContain('Synthetic private task');
        expect(task).not.toMatch(/^Synthetic private task/u);
    });

    it('refuses an owner caller that names no Project, before any Session exists', async () => {
        const { database, service, request } = await fixture();
        const owner = { principal: { kind: 'human-cli' as const, id: 'owner', generation: 1 } };
        const sessionsBefore = database.listSessions().length;

        await expect(service.create(randomUUID(), owner, typed('second-opinion'))).rejects.toThrow(
            /Name a Project/u,
        );
        expect(database.listSessions()).toHaveLength(sessionsBefore);
        const receipt = await service.create(randomUUID(), owner, {
            ...typed('second-opinion'),
            projectId: request.projectId,
        });
        expect(receipt.selection?.type).toBe('second-opinion');
    });
});

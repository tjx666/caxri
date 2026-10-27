import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AgentDispatchService } from '../../agent-dispatch';
import { createBotSession, discardBotSession } from '../../bot';
import { CaxriDatabase } from '../../db';
import { createBackgroundSession, discardEmptySession } from '../../session';
import { AgentDelegationService } from '../service';

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-new-session-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const botRoot = join(directory, 'bot');
    const workRoot = join(directory, 'work');
    await mkdir(botRoot);
    await mkdir(workRoot);
    const botProject = database.createProject(botRoot);
    const bot = database.createSession(botProject.id, 'codex');
    database.setAppState('caxriBot', {
        projectId: botProject.id,
        sessionId: bot.session.id,
        terminalId: bot.terminal!.id,
        sessionIds: [],
    });
    const project = database.createProject(workRoot);
    const service = new AgentDelegationService({
        database,
        dispatch: {
            start: (_id, _principal, input, options) => {
                options?.prepared(database.createTerminal(input.sessionId, 'claude'));
                return Promise.resolve({ status: 'running' } as Awaited<
                    ReturnType<AgentDispatchService['start']>
                >);
            },
        },
        userDataPath: directory,
        launchSettings: () => ({ executable: 'claude', args: ['--model', 'sonnet'] }),
        verifyLaunch: () => Promise.resolve(),
        readTranscript: vi.fn().mockResolvedValue(null),
        newSessions: {
            create: (projectId, title, isBot, createdBySessionId) =>
                isBot
                    ? createBotSession(database, projectId, undefined, title)
                    : createBackgroundSession(database, projectId, title, createdBySessionId),
            discard: (sessionId) => {
                if (database.caxriBotRows()?.sessionIds.includes(sessionId))
                    discardBotSession(database, sessionId);
                else discardEmptySession(database, sessionId);
            },
        },
    });
    onTestFinished(() => service.close());
    const botAuthority = {
        principal: {
            kind: 'agent' as const,
            id: 'bot',
            endpointId: 'bot',
            generation: 1,
            projectIds: [botProject.id],
        },
        callerTerminalId: bot.terminal!.id,
    };
    const callerRoot = join(directory, 'caller');
    await mkdir(callerRoot);
    const callerProject = database.createProject(callerRoot);
    const caller = database.createSession(callerProject.id, 'codex');
    const agentAuthority = {
        principal: {
            kind: 'agent' as const,
            id: 'agent',
            endpointId: 'agent',
            generation: 1,
            projectIds: [callerProject.id],
        },
        callerTerminalId: caller.terminal!.id,
    };
    const request = {
        projectId: project.id,
        provider: 'claude' as const,
        prompt: 'Synthetic private task',
        newSession: true as const,
        title: 'Fix login retry',
    };
    return {
        database,
        service,
        botAuthority,
        botSessionId: bot.session.id,
        agentAuthority,
        callerSessionId: caller.session.id,
        callerTerminalId: caller.terminal!.id,
        project,
        request,
    };
}

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
        // The task file pointer is all automatic naming would see, so Caxri Bot's title is kept as a manual one.
        expect(database.getSession(receipt.sessionId)).toMatchObject({
            title: 'Fix login retry',
            titleMode: 'manual',
        });
        expect((await service.create(id, botAuthority, request)).sessionId).toBe(receipt.sessionId);
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

    it('refuses an external delegation identity bound to one Session', async () => {
        const { database, service, project, request } = await fixture();
        const bound = database.createSession(project.id, null);
        const sessionsBefore = database.listVisibleSessions().length;

        await expect(
            service.create(
                randomUUID(),
                {
                    principal: {
                        kind: 'delegation-client',
                        id: 'external',
                        clientId: 'external-client',
                        generation: 1,
                        projectIds: [project.id] as [string],
                        sessionId: bound.session.id,
                        callerProvider: 'codex',
                    },
                },
                request,
            ),
        ).rejects.toThrow('cannot delegate into a new Session');
        expect(database.listVisibleSessions()).toHaveLength(sessionsBefore);
    });
});

/**
 * Creating and talking to Sessions is ordinary Agent work, not a Caxri Bot privilege: an Agent in any Session, Terminal
 * or Chat, used to be refused here, and was steered toward borrowing the owner's identity instead.
 */
describe('Delegation into a new Session from an ordinary Agent', () => {
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
        });
        expect(receipt.callerTerminalId).toBe(callerTerminalId);
        const retried = await service.create(id, authority, continuation);
        expect(retried.sessionId).toBe(receipt.sessionId);
    });
});

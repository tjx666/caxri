import { execFileSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { authorizeDelegationSession } from '../../agent-delegation/admission';
import { CommanderHandoverService } from '../handover';
import { requireCommanderSession } from '../sessions';
import { COMMANDER_WORKSPACE_DIRECTORY } from '../workspace';
import { fixture } from './service.fixture';

describe('Agent Commander service', () => {
    it('creates hidden Commander rows once and records the Terminal before it launches', async () => {
        const {
            createAndStartTerminal,
            database,
            directory,
            restoreTerminals,
            service,
            terminalIdsAtStart,
        } = await fixture();

        const [first, concurrent] = await Promise.all([service.ensure(), service.ensure()]);
        const again = await service.ensure();

        expect(createAndStartTerminal).toHaveBeenCalledOnce();
        expect(createAndStartTerminal.mock.calls[0]?.[1]).toBe('codex');
        expect(terminalIdsAtStart).toEqual([first.identity.terminalId]);
        expect(concurrent.identity).toEqual(first.identity);
        expect(again.identity).toEqual(first.identity);
        expect(restoreTerminals).toHaveBeenCalledExactlyOnceWith(first.identity.sessionId);
        expect(first.workspacePath).toBe(join(directory, COMMANDER_WORKSPACE_DIRECTORY));
        const instructions = await readFile(join(first.workspacePath, 'AGENTS.md'), 'utf8');
        expect(instructions).toContain('"$CAXRI_CLI" <command>');
        // A ready report is checked against the pull request's live head, not the board's cached copy.
        expect(instructions).toContain('headRefOid');
        // The CLI rejects a `--timeout` above 120000 ms, so a longer wait would fail every unattended round.
        const waitTimeouts = instructions
            .matchAll(/--timeout (\d+)/g)
            .map(([, value]) => Number(value))
            .toArray();
        expect(waitTimeouts).not.toHaveLength(0);
        expect(waitTimeouts.every((value) => value <= 120_000)).toBe(true);
        expect(database.listVisibleProjects().map(({ id }) => id)).not.toContain(
            first.identity.projectId,
        );
        expect(database.listVisibleSessions().map(({ id }) => id)).not.toContain(
            first.identity.sessionId,
        );
        expect(service.snapshot()?.identity).toEqual(first.identity);
    });

    it('reports its run state from the Terminal process first, then the Session activity', async () => {
        const { database, service } = await fixture();
        expect(service.status()).toEqual({ state: 'stopped' });

        const { identity } = await service.ensure();
        const session = database.getSession(identity.sessionId)!;
        const activity = vi.spyOn(database, 'getSession');
        database.updateTerminalState(identity.terminalId, 'starting');
        expect(service.status()).toEqual({ state: 'starting' });

        database.updateTerminalState(identity.terminalId, 'running');
        database.updateAgentProcessState(identity.terminalId, 'starting');
        expect(service.status()).toEqual({ state: 'starting' });

        database.updateAgentProcessState(identity.terminalId, 'running');
        for (const [lastActivityState, state] of [
            ['running', 'working'],
            ['waiting', 'waiting'],
            ['completed', 'idle'],
        ] as const) {
            activity.mockReturnValue({ ...session, lastActivityState });
            expect(service.status()).toEqual({ state });
        }

        activity.mockReturnValue({ ...session, lastActivityState: 'running' });
        database.updateAgentProcessState(identity.terminalId, 'stopped');
        expect(service.status()).toEqual({ state: 'stopped' });

        database.updateAgentProcessState(identity.terminalId, 'running');
        database.updateTerminalState(identity.terminalId, 'detached');
        expect(service.status()).toEqual({ state: 'stopped' });
    });

    it('stops the Commander idempotently and restores it on the next ensure', async () => {
        const { cancelRestore, restoreTerminals, sendTerminalChange, service, stopTerminal } =
            await fixture();
        await expect(service.stop()).resolves.toBeNull();
        expect(stopTerminal).not.toHaveBeenCalled();

        const { identity } = await service.ensure();
        await service.stop();
        expect(cancelRestore).toHaveBeenCalledExactlyOnceWith(identity.sessionId);
        expect(stopTerminal).toHaveBeenCalledExactlyOnceWith(identity.terminalId);
        expect(sendTerminalChange).toHaveBeenCalledExactlyOnceWith(identity.terminalId);
        expect(service.status()).toEqual({ state: 'stopped' });

        restoreTerminals.mockClear();
        const reopened = await service.ensure();
        expect(reopened.identity).toEqual(identity);
        expect(restoreTerminals).toHaveBeenCalledExactlyOnceWith(identity.sessionId);
    });

    it('orders a racing stop and reopen so the reopen restores the stopped Terminal', async () => {
        const { restoreTerminals, service, stopTerminal } = await fixture();
        const { identity } = await service.ensure();
        restoreTerminals.mockClear();
        let finishStop!: () => void;
        stopTerminal.mockImplementationOnce(
            () => new Promise<void>((resolve) => (finishStop = resolve)),
        );

        const stopping = service.stop();
        const reopening = service.ensure();
        await vi.waitFor(() => expect(stopTerminal).toHaveBeenCalledOnce());
        expect(restoreTerminals).not.toHaveBeenCalled();
        finishStop();
        await Promise.all([stopping, reopening]);

        expect(restoreTerminals).toHaveBeenCalledExactlyOnceWith(identity.sessionId);
    });

    it('stops the process a spawning restore produces instead of racing its spawn', async () => {
        const { cancelRestore, service, stopTerminal } = await fixture();
        await service.ensure();
        const spawning = Promise.withResolvers<void>();
        cancelRestore.mockImplementationOnce(() => spawning.promise);

        const stopping = service.stop();
        await vi.waitFor(() => expect(cancelRestore).toHaveBeenCalledOnce());
        expect(stopTerminal).not.toHaveBeenCalled();
        spawning.resolve();
        await stopping;

        expect(stopTerminal).toHaveBeenCalledOnce();
    });

    it('runs a reopen that arrives during a stop after it, even while the first ensure is still starting', async () => {
        const { createAndStartTerminal, restoreTerminals, service, stopTerminal } = await fixture();
        const creating = Promise.withResolvers<void>();
        const create = createAndStartTerminal.getMockImplementation()!;
        createAndStartTerminal.mockImplementationOnce(async (...parameters) => {
            await creating.promise;
            return create(...parameters);
        });

        const opening = service.ensure();
        const stopping = service.stop();
        const reopening = service.ensure();
        creating.resolve();
        const [first, , reopened] = await Promise.all([opening, stopping, reopening]);

        expect(reopened.identity).toEqual(first.identity);
        expect(stopTerminal).toHaveBeenCalledExactlyOnceWith(first.identity.terminalId);
        expect(restoreTerminals).toHaveBeenCalledExactlyOnceWith(first.identity.sessionId);
        expect(stopTerminal.mock.invocationCallOrder[0]).toBeLessThan(
            restoreTerminals.mock.invocationCallOrder[0],
        );
    });

    it('keeps a hand-over accepted while the first Commander Terminal is being created', async () => {
        const { createAndStartTerminal, database, sendFullStateChange, service, userSession } =
            await fixture();
        const creating = Promise.withResolvers<void>();
        const reached = Promise.withResolvers<void>();
        const create = createAndStartTerminal.getMockImplementation()!;
        createAndStartTerminal.mockImplementationOnce(async (...parameters) => {
            reached.resolve();
            await creating.promise;
            return create(...parameters);
        });
        const handovers = new CommanderHandoverService({
            database,
            notify: () => {},
            resolveProjectRoot: (path) => Promise.resolve(path),
            sendFullStateChange,
        });

        const opening = service.ensure();
        await reached.promise;
        const result = await handovers.handOver({ sessionIds: [userSession.id] });
        creating.resolve();
        const { identity } = await opening;

        expect(result.outcomes).toEqual([
            expect.objectContaining({ outcome: 'accepted', sessionId: userSession.id }),
        ]);
        expect(database.agentCommanderRows()).toMatchObject({
            terminalId: identity.terminalId,
            sessionIds: [userSession.id],
        });
    });

    it('makes the workspace its own Git repository even inside another repository', async () => {
        const { directory, service } = await fixture();
        execFileSync('git', ['init', '--quiet'], { cwd: directory });

        const { workspacePath } = await service.ensure();
        await service.ensure();

        const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd: join(workspacePath, 'tasks'),
            encoding: 'utf8',
        }).trim();
        expect(await realpath(topLevel)).toBe(workspacePath);
    });

    it('admits archiving only a Session the Commander created', async () => {
        const { database, service, userProject, userSession } = await fixture();
        const commander = await service.ensure();
        const created = service.createSession(userProject.id);

        expect(() => requireCommanderSession(database, created.sessionId)).not.toThrow();
        for (const sessionId of [userSession.id, commander.identity.sessionId, 'missing'])
            expect(() => requireCommanderSession(database, sessionId)).toThrow(
                expect.objectContaining({ code: 'NOT_FOUND' }),
            );
    });

    it('refuses archiving a Session the user handed over even though the Commander manages it', async () => {
        const { database, sendFullStateChange, service, userProject, userSession } =
            await fixture();
        await service.ensure();
        const created = service.createSession(userProject.id);
        const handovers = new CommanderHandoverService({
            database,
            notify: () => {},
            resolveProjectRoot: (path) => Promise.resolve(path),
            sendFullStateChange,
        });

        const result = await handovers.handOver({ sessionIds: [userSession.id] });

        expect(result.outcomes).toEqual([
            expect.objectContaining({ outcome: 'accepted', sessionId: userSession.id }),
        ]);
        expect(database.agentCommanderRows()?.sessionIds).toContain(userSession.id);
        expect(() => requireCommanderSession(database, userSession.id)).toThrow(
            expect.objectContaining({ code: 'NOT_FOUND' }),
        );
        expect(() => requireCommanderSession(database, created.sessionId)).not.toThrow();
    });

    it('creates Commander Sessions without moving the Workbench selection', async () => {
        const { database, sendFullStateChange, service, userProject, userSession } =
            await fixture();
        const commander = await service.ensure();
        database.selectSession(userSession.id, 'main');

        const created = service.createSession(userProject.id);

        expect(database.windowOpenSessions.get('main').activeSessionId).toBe(userSession.id);
        expect(database.agentCommanderRows()?.sessionIds).toEqual([created.sessionId]);
        expect(sendFullStateChange).toHaveBeenCalledOnce();
        expect(() => service.createSession(commander.identity.projectId)).toThrow(
            expect.objectContaining({ code: 'NOT_FOUND' }),
        );
        const board = service.board();
        expect(board.projects.map(({ id }) => id)).toEqual([userProject.id]);
        expect(
            board.rows.map(({ sessionId, commanderSession }) => [sessionId, commanderSession]),
        ).toEqual(
            expect.arrayContaining([
                [created.sessionId, true],
                [userSession.id, false],
            ]),
        );
    });

    /**
     * Commander ownership is what admits delegation into a Session and marks it on the board. Dropping the oldest
     * record to make room silently took both away from a Session that may still run a task.
     */
    it('refuses a new Commander Session at capacity instead of disowning the oldest', async () => {
        const { database, service, userProject } = await fixture();
        await service.ensure();
        const rows = database.agentCommanderRows()!;
        const owned = Array.from(
            { length: 1_000 },
            () =>
                database.createSession(userProject.id, null, undefined, { selection: 'preserve' })
                    .session.id,
        );
        database.setAppState('agentCommander', { ...rows, sessionIds: owned });
        const sessionCount = database.listSessions(userProject.id).length;

        expect(() => service.createSession(userProject.id)).toThrow(
            expect.objectContaining({ code: 'CAPACITY' }),
        );
        expect(database.agentCommanderRows()?.sessionIds).toEqual(owned);
        expect(database.listSessions(userProject.id)).toHaveLength(sessionCount);
    });

    it("shows each Commander Session's latest Commander task, ignoring other callers", async () => {
        const { database, service, userProject } = await fixture();
        await service.ensure();
        const { sessionId } = service.createSession(userProject.id);
        const commanderTerminalId = database.agentCommanderRows()!.terminalId!;
        const task = (delegationId: string, callerTerminalId: string, createdAt: number) =>
            database.agentDelegations.insert({
                receipt: {
                    delegationId,
                    projectId: userProject.id,
                    sessionId,
                    callerTerminalId,
                    provider: 'codex',
                    status: 'blocked',
                    revision: 1,
                    createdAt,
                    updatedAt: createdAt,
                },
                principal: { kind: 'human-cli', id: 'synthetic-owner' },
                input: { projectId: userProject.id, sessionId, provider: 'codex', prompt: 'Task' },
                fingerprint: `fingerprint-${delegationId}`,
                promptDigest: 'a'.repeat(64),
                frozenLaunch: { executable: 'codex', args: [] },
            });
        task('commander-task', commanderTerminalId, 10);
        task('foreign-task', 'another-terminal', 20);

        const row = service.board().rows.find((candidate) => candidate.sessionId === sessionId);

        expect(row?.task).toEqual({
            delegationId: 'commander-task',
            status: 'blocked',
            updatedAt: 10,
        });
    });

    it('admits Commander delegation only into its own Sessions from its exact Terminal', async () => {
        const { database, service, userProject, userSession } = await fixture();
        const commander = await service.ensure();
        const created = service.createSession(userProject.id);
        const authority = {
            principal: {
                kind: 'agent' as const,
                id: 'agent:commander',
                endpointId: 'commander',
                generation: 1,
                projectIds: [commander.identity.projectId],
            },
            callerTerminalId: commander.identity.terminalId,
        };

        expect(() =>
            authorizeDelegationSession(database, authority, {
                projectId: userProject.id,
                sessionId: created.sessionId,
            }),
        ).not.toThrow();
        expect(() =>
            authorizeDelegationSession(database, authority, {
                projectId: userProject.id,
                sessionId: userSession.id,
            }),
        ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
        expect(() =>
            authorizeDelegationSession(
                database,
                { ...authority, callerTerminalId: 'another-terminal' },
                { projectId: userProject.id, sessionId: created.sessionId },
            ),
        ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
        database.hideProject(userProject.id);
        expect(() =>
            authorizeDelegationSession(database, authority, {
                projectId: userProject.id,
                sessionId: created.sessionId,
            }),
        ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
    });
});

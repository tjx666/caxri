import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BootstrapState, CommanderIdentity, TerminalKind } from '@caxri/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { authorizeDelegationSession } from '../../agent-delegation/admission';
import { CaxriDatabase } from '../../db';
import { AgentCommanderService } from '../service';
import { COMMANDER_WORKSPACE_DIRECTORY } from '../workspace';

async function fixture() {
    const directory = await realpath(await mkdtemp(`${tmpdir()}/caxri-commander-`));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const userRoot = join(directory, 'repository');
    await mkdir(userRoot);
    const userProject = database.createProject(userRoot);
    const userSession = database.createSession(userProject.id, 'shell').session;
    const terminalIdsAtStart: Array<string | undefined> = [];
    const createAndStartTerminal = vi.fn(
        (
            sessionId: string,
            kind: TerminalKind,
            cwd: string,
            beforeStart: (terminal: { id: string }) => void,
        ) => {
            const terminal = database.createTerminal(sessionId, kind, cwd);
            beforeStart(terminal);
            terminalIdsAtStart.push(database.agentCommanderRows()?.terminalId);
            return Promise.resolve(terminal);
        },
    );
    const sendFullStateChange = vi.fn();
    const restoreTerminals = vi.fn();
    const service = new AgentCommanderService({
        database,
        createAndStartTerminal,
        now: () => 1_000,
        probeTerminal: () => {},
        restoreTerminals,
        pullRequests: () => ({ pullRequests: {}, refreshedAt: 5 }),
        scopedWorkbench: (identity: CommanderIdentity) =>
            ({ selectedSessionId: identity.sessionId }) as BootstrapState,
        sendFullStateChange,
        userDataPath: directory,
    });
    return {
        createAndStartTerminal,
        database,
        directory,
        restoreTerminals,
        sendFullStateChange,
        service,
        terminalIdsAtStart,
        userProject,
        userSession,
    };
}

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
        await expect(readFile(join(first.workspacePath, 'AGENTS.md'), 'utf8')).resolves.toContain(
            'node "$CAXRI_CLI_PATH"',
        );
        expect(database.listVisibleProjects().map(({ id }) => id)).not.toContain(
            first.identity.projectId,
        );
        expect(database.listVisibleSessions().map(({ id }) => id)).not.toContain(
            first.identity.sessionId,
        );
        expect(service.snapshot()?.identity).toEqual(first.identity);
    });

    it('creates Commander Sessions without moving the Workbench selection', async () => {
        const { database, sendFullStateChange, service, userProject, userSession } =
            await fixture();
        const commander = await service.ensure();
        database.selectSession(userSession.id);

        const created = service.createSession(userProject.id);

        expect(database.getAppState('lastSelectedSessionId')).toBe(userSession.id);
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

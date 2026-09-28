import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AgentDispatchService } from '../../agent-dispatch';
import { createCommanderSession, discardCommanderSession } from '../../commander';
import { CaxriDatabase } from '../../db';
import { AgentDelegationService } from '../service';

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-new-session-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(async () => {
        database.close();
        await rm(directory, { recursive: true, force: true });
    });
    const commanderRoot = join(directory, 'commander');
    const workRoot = join(directory, 'work');
    await mkdir(commanderRoot);
    await mkdir(workRoot);
    const commanderProject = database.createProject(commanderRoot);
    const commander = database.createSession(commanderProject.id, 'codex');
    database.setAppState('agentCommander', {
        projectId: commanderProject.id,
        sessionId: commander.session.id,
        terminalId: commander.terminal!.id,
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
        commanderSessions: {
            create: (projectId) => createCommanderSession(database, projectId),
            discard: (sessionId) => discardCommanderSession(database, sessionId),
        },
    });
    onTestFinished(() => service.close());
    const commanderAuthority = {
        principal: {
            kind: 'agent' as const,
            id: 'commander',
            endpointId: 'commander',
            generation: 1,
            projectIds: [commanderProject.id],
        },
        callerTerminalId: commander.terminal!.id,
    };
    const request = {
        projectId: project.id,
        provider: 'claude' as const,
        prompt: 'Synthetic private task',
        newSession: true as const,
    };
    return { database, service, commanderAuthority, request };
}

/**
 * The Commander used to create an empty Session in one command and delegate into it in the next, so the Workbench
 * showed an empty Session for as long as the Commander took to write that second command.
 */
describe('Delegation into a new Commander Session', () => {
    it('creates the Session together with its task, and a retry reuses it', async () => {
        const { database, service, commanderAuthority, request } = await fixture();
        const id = randomUUID();

        const receipt = await service.create(id, commanderAuthority, request);

        expect(database.agentCommanderRows()?.sessionIds).toEqual([receipt.sessionId]);
        expect(database.listTerminals(receipt.sessionId)).toHaveLength(1);
        expect((await service.create(id, commanderAuthority, request)).sessionId).toBe(
            receipt.sessionId,
        );
    });

    it('removes the Session a concurrent retry created when both join one task', async () => {
        const { database, service, commanderAuthority, request } = await fixture();
        const id = randomUUID();

        const [first, second] = await Promise.all([
            service.create(id, commanderAuthority, request),
            service.create(id, commanderAuthority, request),
        ]);

        expect(second.sessionId).toBe(first.sessionId);
        expect(database.agentCommanderRows()?.sessionIds).toEqual([first.sessionId]);
    });

    it('removes the Session again when admission refuses the task', async () => {
        const { database, service, commanderAuthority, request } = await fixture();
        const sessionsBefore = database.listVisibleSessions().length;

        await expect(
            service.create(randomUUID(), commanderAuthority, {
                ...request,
                provider: undefined,
                preset: 'missing-preset',
            }),
        ).rejects.toThrow();

        expect(database.listVisibleSessions()).toHaveLength(sessionsBefore);
        expect(database.agentCommanderRows()?.sessionIds).toEqual([]);
    });

    it('refuses a caller other than the Agent Commander', async () => {
        const { service, request } = await fixture();

        await expect(
            service.create(
                randomUUID(),
                { principal: { kind: 'human-cli', id: 'owner' } },
                request,
            ),
        ).rejects.toThrow('Only the Agent Commander');
    });
});

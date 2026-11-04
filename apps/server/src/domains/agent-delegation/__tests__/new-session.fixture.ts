import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { onTestFinished, vi } from 'vitest';

import type { AgentDispatchService } from '../../agent-dispatch';
import { createBotSession, discardBotSession } from '../../bot';
import { CaxriDatabase } from '../../db';
import { addProjectFolderWithOutcome } from '../../project';
import { createBackgroundSession, discardEmptySession } from '../../session';
import { AgentDelegationService } from '../service';

/**
 * A Server whose `newSession` delegations create real Sessions: Caxri Bot, an ordinary Agent in another Project, and
 * the owner, with a folder-adding step wired like production. `events` collects what the Server would emit.
 */
export async function newSessionFixture() {
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
    const events: ServerEvent[] = [];
    const logger = { write: vi.fn() } as unknown as StructuredLogger;
    const service = new AgentDelegationService({
        database,
        logger,
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
            create: (projectId, title, isBot, createdBySessionId, createdByRelation, worktree) => {
                if (isBot) return createBotSession(database, projectId, undefined, title);
                const sessionId = createBackgroundSession(
                    database,
                    projectId,
                    title,
                    createdBySessionId,
                    createdByRelation,
                );
                if (worktree)
                    database.selectWorkbenchProject(
                        sessionId,
                        worktree.projectId,
                        worktree.identity,
                    );
                return sessionId;
            },
            addProject: async (absolutePath) => {
                const { project, outcome } = await addProjectFolderWithOutcome(
                    database,
                    (event) => events.push(event),
                    absolutePath,
                );
                return { id: project.id, outcome };
            },
            prepareWorktree: (projectId, branch) => {
                if (branch === 'refused') return Promise.reject(new Error('git refused'));
                const worktree = database.createProject(join(directory, `wt-${branch}`), projectId);
                return Promise.resolve({
                    projectId: worktree.id,
                    identity: { device: '1', inode: '2' },
                });
            },
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
        directory,
        database,
        events,
        logger,
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

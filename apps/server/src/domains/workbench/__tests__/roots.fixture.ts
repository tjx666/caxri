import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NewWorktreeBehavior, ServerEvent, SessionRecord } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { expect, onTestFinished, vi } from 'vitest';

import type { AgentLifecyclePhase } from '../../agents/index';
import { CaxriDatabase } from '../../db/repository';
import type { GitService, GitWorktreeTopology } from '../../git/index';
import { ProjectRootResolver } from '../../project/roots';
import type { SessionTranscriptContext } from '../../session/context';
import { WorkbenchRootService } from '../roots';

export async function fixture(
    sessionCount = 1,
    options: {
        beforeRootIdentityRealpath?: () => Promise<void>;
        sessionContext?: (session: SessionRecord) => Promise<SessionTranscriptContext>;
    } = {},
) {
    const createdDirectory = await mkdtemp(join(tmpdir(), 'caxri-workbench-roots-'));
    const directory = await realpath(createdDirectory);
    const ownerRoot = join(directory, 'owner');
    const worktreeRoot = join(directory, 'worktree');
    await Promise.all([mkdir(ownerRoot), mkdir(worktreeRoot)]);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const owner = database.createProject(ownerRoot);
    const sessions = Array.from({ length: sessionCount }, () =>
        database.createSession(owner.id, 'codex'),
    );
    const events: ServerEvent[] = [];
    let behavior: NewWorktreeBehavior = 'ask';
    let topology: GitWorktreeTopology = {
        repositoryKey: join(directory, '.git'),
        worktrees: [{ branch: 'main', rootPath: ownerRoot }],
    };
    const worktreeTopology = vi.fn(() => Promise.resolve(topology));
    const logger = new StructuredLogger(join(directory, 'logs'));
    onTestFinished(async () => {
        await logger.flush();
        await rm(directory, { recursive: true, force: true });
    });
    const service = new WorkbenchRootService({
        behavior: () => behavior,
        database,
        emit: (event) => {
            events.push(event);
        },
        git: { worktreeTopology } as unknown as GitService,
        logger,
        ...options,
    });
    return {
        database,
        directory,
        events,
        getTopology: () => topology,
        /**
         * Flushes and reads back this fixture's structured log so a test can assert the event a silent code path leaves
         * behind, which is the only trace some decisions produce.
         */
        readLogEvents: async (): Promise<
            Array<{ event: string; fields?: Record<string, unknown> }>
        > => {
            await logger.flush();
            const contents = await readFile(join(directory, 'logs', 'server-core.jsonl'), 'utf8');
            return contents
                .split('\n')
                .filter(Boolean)
                .map(
                    (line) =>
                        JSON.parse(line) as { event: string; fields?: Record<string, unknown> },
                );
        },
        owner,
        ownerRoot,
        /**
         * The same persisted binding gates Workbench Root path resolution, so identity regressions must be asserted on
         * both readers rather than on the validation sweep alone.
         */
        projectRoots: new ProjectRootResolver(database),
        service,
        sessions,
        setBehavior: (value: NewWorktreeBehavior) => {
            behavior = value;
        },
        setWorktrees: (worktrees: GitWorktreeTopology['worktrees']) => {
            topology = { ...topology, worktrees };
        },
        worktreeRoot,
        worktreeTopology,
    };
}

export function prime(
    context: Awaited<ReturnType<typeof fixture>>,
    launchId = 'launch-1',
    sessionIndex = 0,
): Promise<boolean> {
    const created = context.sessions[sessionIndex];
    return context.service.primeAgentLaunch({
        launchId,
        projectId: context.owner.id,
        provider: 'codex',
        sessionId: created.session.id,
        terminalId: created.terminal!.id,
    });
}

export interface ShellSignalOptions {
    launchId?: string;
    sessionIndex?: number;
    toolUseId?: string;
    worktreeCreateIntent?: true;
}

function shellSignal(
    context: Awaited<ReturnType<typeof fixture>>,
    phase: 'shellToolFailed' | 'shellToolFinished' | 'shellToolStarted',
    options: ShellSignalOptions = {},
) {
    const terminal = context.sessions[options.sessionIndex ?? 0].terminal!;
    return {
        launchId: options.launchId ?? 'launch-1',
        phase,
        provider: 'codex' as const,
        terminalId: terminal.id,
        ...(options.worktreeCreateIntent && {
            agentToolUseId: options.toolUseId ?? 'tool-use-1',
            worktreeCreateIntent: true as const,
        }),
    };
}

export function shellStarted(
    context: Awaited<ReturnType<typeof fixture>>,
    options: ShellSignalOptions = {},
) {
    return shellSignal(context, 'shellToolStarted', options);
}

export function shellFinished(
    context: Awaited<ReturnType<typeof fixture>>,
    options: ShellSignalOptions = {},
) {
    return shellSignal(context, 'shellToolFinished', options);
}

export function shellFailed(
    context: Awaited<ReturnType<typeof fixture>>,
    options: ShellSignalOptions = {},
) {
    return shellSignal(context, 'shellToolFailed', options);
}

/**
 * A lifecycle signal carrying the provider's own reported working directory. The default phase is deliberately not a
 * shell phase: the divergence path must not depend on a Bash tool event.
 */
export function agentCwdSignal(
    context: Awaited<ReturnType<typeof fixture>>,
    agentCwd: string,
    options: { launchId?: string; phase?: AgentLifecyclePhase; sessionIndex?: number } = {},
) {
    const terminal = context.sessions[options.sessionIndex ?? 0].terminal!;
    return {
        agentCwd,
        launchId: options.launchId ?? 'launch-1',
        phase: options.phase ?? ('turnStarted' as const),
        provider: 'codex' as const,
        terminalId: terminal.id,
    };
}

export async function beginWorktreeCreation(
    context: Awaited<ReturnType<typeof fixture>>,
    options: ShellSignalOptions = {},
): Promise<void> {
    await expect(
        context.service.observeShellToolStarted(
            shellStarted(context, { ...options, worktreeCreateIntent: true }),
            () => true,
        ),
    ).resolves.toBe('accepted');
}

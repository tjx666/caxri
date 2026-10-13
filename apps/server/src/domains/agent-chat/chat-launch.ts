import type {
    AgentChatFailureReason,
    AgentLaunchSettings,
    AgentProvider,
    TerminalFailureReason,
    TerminalRecord,
} from '@caxri/protocol';
import { agentProviderCatalog, CaxriError, errorMessage, isChatTerminal } from '@caxri/protocol';
import { assertE2EAgentChatLaunch, logEventCatalog, readE2EAgentPolicy } from '@caxri/system';

import type { AgentLifecycleSignal } from '../agents';
import { agentCommandEnvironment, readAgentTranscript } from '../agents';
import type { CaxriDatabase } from '../db';
import type { TerminalWorkingDirectoryIdentity } from '../terminal';
import {
    assertTerminalWorkingDirectory,
    resolveTerminalExecutable,
    terminalDirectoryIdentity,
} from '../terminal';
import { agentChatDrivers } from './chat-drivers';
import type {
    AgentChatExit,
    AgentChatSessionHost,
    AgentChatTranscript,
    ChatLifecycleEvent,
} from './chat-provider';
import { AgentChatStartError } from './chat-provider';
import type { AgentChatServiceOptions } from './service-options';

/**
 * The Terminal failure a Chat start failure is recorded as.
 */
const TERMINAL_FAILURE_REASONS: Record<AgentChatFailureReason, TerminalFailureReason> = {
    executable_not_found: 'executable_not_found',
    spawn_failed: 'spawn_failed',
    handshake_failed: 'spawn_failed',
    process_exited: 'spawn_failed',
    resume_failed: 'agent_session_unavailable',
    conversation_in_use: 'agent_session_unavailable',
    unsupported_version: 'spawn_failed',
};

/**
 * The Chat Terminal a request names, with its provider. Fails with `NOT_FOUND` or, for a Terminal that does not use
 * Chat, `UNAVAILABLE`.
 */
export function requireChatTerminal(
    database: CaxriDatabase,
    terminalId: string,
): TerminalRecord & { provider: AgentProvider } {
    const terminal = database.getTerminal(terminalId);
    if (!terminal) throw new CaxriError('NOT_FOUND', 'Terminal not found');
    const { provider } = terminal;
    if (!provider || !isChatTerminal(terminal) || !agentChatDrivers[provider])
        throw new CaxriError('UNAVAILABLE', 'This Terminal does not use Chat');
    return { ...terminal, provider };
}

/**
 * What resolving a provider launch needs; a headless Benchmark turn supplies it without a Chat service.
 */
export type AgentChatLaunchOptions = Pick<
    AgentChatServiceOptions,
    'agentEnvironment' | 'environment' | 'resolveExecutable'
>;

const WORKING_DIRECTORY_CHANGED = 'The working directory changed or is missing; Chat did not start';

/**
 * Resolves what a provider process needs before it spawns: the executable, its environment, and a revalidated cwd.
 * Rejects with {@link AgentChatStartError}.
 *
 * A Chat's cwd was authorized when its Terminal was created, but its provider starts lazily, possibly much later, and
 * every Chat start (first read, restart, a switch to Chat, resume) runs through here. So, like the PTY launch path
 * (`terminalDirectoryIdentity` in the launch handlers, `assertTerminalWorkingDirectory` in the launch plan), the cwd's
 * identity is captured first and revalidated as the last await before spawn: a folder swapped for a symlink, replaced,
 * or removed fails the start instead of running the Agent somewhere else.
 */
export async function prepareChatLaunch(
    options: AgentChatLaunchOptions,
    provider: AgentProvider,
    launch: AgentLaunchSettings,
    cwd: string,
): Promise<{
    cwd: string;
    executable: string;
    environment: NodeJS.ProcessEnv;
    isRealAgentE2E: boolean;
}> {
    let expectedWorkingDirectory: TerminalWorkingDirectoryIdentity;
    try {
        expectedWorkingDirectory = await terminalDirectoryIdentity(cwd);
    } catch {
        throw new AgentChatStartError('spawn_failed', WORKING_DIRECTORY_CHANGED);
    }
    /**
     * Real-Agent E2E may start a Chat only when the run was authorized for the Chat surface; the thread then ignores
     * the user's launch settings for a fixed read-only, approval-free configuration.
     */
    const e2ePolicy = readE2EAgentPolicy();
    try {
        assertE2EAgentChatLaunch(e2ePolicy, provider, launch);
    } catch {
        throw new AgentChatStartError('spawn_failed', 'Chat is unavailable in this real-Agent E2E');
    }
    let executable: string;
    try {
        executable = await resolveTerminalExecutable(provider, launch, options.resolveExecutable);
    } catch {
        throw new AgentChatStartError(
            'executable_not_found',
            `${agentProviderCatalog[provider].displayName} CLI was not found`,
        );
    }
    const environment = await (options.environment?.() ??
        agentCommandEnvironment(options.agentEnvironment));
    try {
        await assertTerminalWorkingDirectory(cwd, expectedWorkingDirectory);
    } catch {
        throw new AgentChatStartError('spawn_failed', WORKING_DIRECTORY_CHANGED);
    }
    return { cwd, executable, environment, isRealAgentE2E: e2ePolicy?.mode === 'real' };
}

/**
 * Bounded tail of a bound Chat's on-disk Agent transcript, for providers whose resume does not return history.
 */
export async function readChatTranscript(
    options: Pick<AgentChatServiceOptions, 'agentEnvironment' | 'database'>,
    terminalId: string,
    maxBytes?: number,
): Promise<AgentChatTranscript | undefined> {
    const transcript = await readAgentTranscript(
        options.database,
        terminalId,
        true,
        options.agentEnvironment,
        maxBytes,
    );
    return transcript?.content === undefined
        ? undefined
        : { content: transcript.content, truncated: transcript.truncated };
}

/**
 * The content-free record of one provider process lifetime.
 */
export function logChatProcessExited(
    options: AgentChatServiceOptions,
    terminalId: string,
    exit: AgentChatExit,
): void {
    options.logger.write(
        exit.requested ? 'info' : 'warn',
        logEventCatalog.agentChat.processExited,
        {
            fields: {
                terminalId,
                reason: exit.end.reason,
                requested: exit.requested,
                ...(exit.end.reason === 'exited' && {
                    exitCode: exit.end.exitCode,
                    signal: exit.end.signal,
                }),
                turns: exit.turns,
                serverRequests: exit.serverRequests,
                rejectedRequests: exit.rejectedRequests,
                droppedFrames: exit.droppedFrames,
            },
        },
    );
}

/**
 * The closed failure a start error is shown and recorded as, logged with the start duration.
 */
export function chatStartFailure(
    options: AgentChatServiceOptions,
    terminal: { id: string; provider: AgentProvider },
    error: unknown,
    startedAt: number,
): { reason: AgentChatFailureReason; detail?: string } {
    const failure =
        error instanceof AgentChatStartError
            ? { reason: error.reason, detail: error.detail }
            : {
                  reason: 'spawn_failed' as const,
                  detail: `${agentProviderCatalog[terminal.provider].displayName} Chat could not start`,
              };
    options.logger.write('warn', logEventCatalog.agentChat.processStarted, {
        fields: {
            terminalId: terminal.id,
            outcome: 'failed',
            reason: failure.reason,
            durationMs: Date.now() - startedAt,
            ...(!(error instanceof AgentChatStartError) && {
                error: errorMessage(error, 'unknown'),
            }),
        },
    });
    return failure;
}

/**
 * Records a failed start on the Chat's Terminal and agent process, and ends its launch. Returns `false` when the
 * Terminal no longer exists, so there is no change to broadcast.
 */
export function didPersistChatStartFailure(
    options: AgentChatServiceOptions,
    terminalId: string,
    failure: { reason: AgentChatFailureReason; detail?: string },
): boolean {
    const { database } = options;
    options.coordinator.endTerminalLaunch(terminalId);
    if (!database.getTerminal(terminalId)) return false;
    database.updateTerminalState(
        terminalId,
        'failed',
        TERMINAL_FAILURE_REASONS[failure.reason],
        failure.detail,
    );
    database.updateAgentProcessState(terminalId, 'failed');
    return true;
}

/**
 * Hands a lifecycle signal synthesized from the provider protocol to the shared Agent lifecycle path. Delivery is
 * ordered by the coordinator, not by this caller, so it runs in the background and logs a rejection.
 */
export function forwardChatLifecycle(
    options: Pick<AgentChatServiceOptions, 'logger' | 'observeLifecycleSignal'>,
    signal: AgentLifecycleSignal,
): void {
    // eslint-disable-next-line no-void -- lifecycle delivery is ordered by the coordinator, not by this caller.
    void observeChatLifecycle(options, signal);
}

/**
 * The `lifecycle` and `observeLifecycle` members of a Chat host, scoped to one launch. Events from a superseded launch
 * are dropped before they reach the shared lifecycle path.
 */
export function chatLifecycleHost(
    options: Pick<AgentChatServiceOptions, 'logger' | 'observeLifecycleSignal'>,
    scope: Pick<AgentLifecycleSignal, 'launchId' | 'provider' | 'terminalId'> & {
        isCurrent: () => boolean;
        onEvent: (event: ChatLifecycleEvent) => void;
    },
): Pick<AgentChatSessionHost, 'lifecycle' | 'observeLifecycle'> {
    const { isCurrent, onEvent, ...identity } = scope;
    return {
        lifecycle: (event) => {
            if (!isCurrent()) return;
            onEvent(event);
            forwardChatLifecycle(options, { ...event, ...identity });
        },
        observeLifecycle: async (event) => {
            if (!isCurrent()) return;
            onEvent(event);
            await observeChatLifecycle(options, { ...event, ...identity });
        },
    };
}

async function observeChatLifecycle(
    options: Pick<AgentChatServiceOptions, 'logger' | 'observeLifecycleSignal'>,
    signal: AgentLifecycleSignal,
): Promise<void> {
    try {
        await options.observeLifecycleSignal(signal);
    } catch (error: unknown) {
        options.logger.write('warn', logEventCatalog.agentChat.protocolRejected, {
            fields: {
                terminalId: signal.terminalId,
                reason: 'lifecycleFailed',
                error: errorMessage(error, 'unknown'),
            },
        });
    }
}

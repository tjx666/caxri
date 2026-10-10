import type {
    AgentChatFailureReason,
    AgentLaunchSettings,
    AgentProvider,
    TerminalFailureReason,
    TerminalRecord,
} from '@caxri/protocol';
import { agentProviderCatalog, CaxriError, errorMessage, isChatTerminal } from '@caxri/protocol';
import { assertE2EAgentChatLaunch, logEventCatalog, readE2EAgentPolicy } from '@caxri/system';

import { agentCommandEnvironment, readAgentTranscript } from '../agents';
import type { CaxriDatabase } from '../db';
import { resolveTerminalExecutable } from '../terminal';
import { agentChatDrivers } from './chat-drivers';
import type { AgentChatExit, AgentChatTranscript } from './chat-provider';
import { AgentChatStartError } from './chat-provider';
import type { AgentChatServiceOptions } from './service-options';

/**
 * The Terminal failure a Chat start failure is recorded as.
 */
export const TERMINAL_FAILURE_REASONS: Record<AgentChatFailureReason, TerminalFailureReason> = {
    executable_not_found: 'executable_not_found',
    spawn_failed: 'spawn_failed',
    handshake_failed: 'spawn_failed',
    process_exited: 'spawn_failed',
    resume_failed: 'agent_session_unavailable',
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
 * Resolves what a provider process needs before it spawns: the executable and its environment. Rejects with
 * {@link AgentChatStartError}.
 */
export async function prepareChatLaunch(
    options: AgentChatServiceOptions,
    provider: AgentProvider,
    launch: AgentLaunchSettings,
): Promise<{ executable: string; environment: NodeJS.ProcessEnv; isRealAgentE2E: boolean }> {
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
    return { executable, environment, isRealAgentE2E: e2ePolicy?.mode === 'real' };
}

/**
 * Bounded tail of a bound Chat's on-disk Agent transcript, for providers whose resume does not return history.
 */
export async function readChatTranscript(
    options: AgentChatServiceOptions,
    terminalId: string,
): Promise<AgentChatTranscript | undefined> {
    const transcript = await readAgentTranscript(
        options.database,
        terminalId,
        true,
        options.agentEnvironment,
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

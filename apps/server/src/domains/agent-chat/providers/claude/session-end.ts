import { endedSessionOperations } from '../../chat-items';
import type { AgentChatSessionHost, ChatProcessEnd } from '../../chat-provider';
import type { ProviderProcess } from '../../provider-process';

/**
 * What a Claude Chat's ended provider process reports once its stream closed.
 */
interface ClaudeSessionEndInput {
    child: ProviderProcess['child'] | undefined;
    host: Pick<AgentChatSessionHost, 'apply' | 'lifecycle' | 'onExit' | 'read'>;
    requested: boolean;
    /**
     * The broker whose unanswered requests the end resolves.
     */
    requests: { count: number; drain(): Iterable<string> };
    sessionId: string;
    spawnErrorCode: string | undefined;
    turns: number;
}

/**
 * Settles a Claude Chat whose stream closed: closes dangling items, resolves the attention requests the Agent never got
 * an answer to, and reports how the process ended to the host (a requested close, a spawn that never produced a pid, or
 * an exit with its status).
 */
export function reportClaudeSessionEnd(input: ClaudeSessionEndInput): void {
    const { child, host, requested, requests, sessionId, spawnErrorCode } = input;
    const snapshot = host.read();
    const { activeTurnId } = snapshot;
    const keys = requests.drain();
    host.apply(endedSessionOperations(snapshot));
    for (const key of keys)
        host.lifecycle({
            phase: 'attentionResolved',
            agentSessionId: sessionId,
            agentToolUseId: key,
        });
    const end: ChatProcessEnd = requested
        ? { reason: 'closed' }
        : spawnErrorCode !== undefined || !child?.pid
          ? { reason: 'spawnFailed', ...(spawnErrorCode && { code: spawnErrorCode }) }
          : { reason: 'exited', exitCode: child.exitCode, signal: child.signalCode };
    host.onExit({
        end,
        requested,
        ...(activeTurnId && { activeTurnId }),
        turns: input.turns,
        serverRequests: requests.count,
        rejectedRequests: 0,
        droppedFrames: 0,
    });
}

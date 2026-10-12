import type { AgentChatContextReport } from '@caxri/protocol';
import { agentChatContextReportSchema, CaxriError } from '@caxri/protocol';

import { readChatTranscript, requireChatTerminal } from './chat-launch';
import type { AgentChatProviderSession, ChatContextDetails } from './chat-provider';
import { claudeContextRequests } from './claude-context-requests';
import type { AgentChatServiceOptions } from './service-options';

/**
 * The Context tab's report for one Chat. The request history is replayed from the provider's on-disk record, so a Chat
 * whose process is not running still shows how its cache held up; the composition needs the live process and is left
 * out without one, because reading a report must never spawn a provider. Only Claude Code writes a record with
 * per-request cache usage and answers a context query.
 */
export async function readChatContext(
    options: Pick<AgentChatServiceOptions, 'agentEnvironment' | 'database'>,
    terminalId: string,
    session: AgentChatProviderSession | undefined,
): Promise<AgentChatContextReport> {
    const { provider } = requireChatTerminal(options.database, terminalId);
    if (provider !== 'claude')
        throw new CaxriError('VALIDATION', 'Only Claude Code Chats report their context');
    const [live, transcript] = await Promise.all([
        session?.isOpen ? readLiveContext(session) : undefined,
        readChatTranscript(options, terminalId),
    ]);
    return agentChatContextReportSchema.parse({
        generatedAt: Date.now(),
        ...(live?.composition && { composition: live.composition }),
        requests: transcript ? claudeContextRequests(transcript.content) : [],
        isHistoryTruncated: transcript?.truncated ?? false,
        changes: live?.changes ?? [],
    });
}

/**
 * A process that does not answer in time leaves the report with its history alone.
 */
async function readLiveContext(
    session: AgentChatProviderSession,
): Promise<ChatContextDetails | undefined> {
    try {
        return await session.readContext?.();
    } catch {
        return undefined;
    }
}

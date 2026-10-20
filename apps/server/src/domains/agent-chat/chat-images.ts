import type { AgentChatImageInput } from '@caxri/protocol';
import { SingleFlight } from '@caxri/system';

import { MAX_HISTORY_TRANSCRIPT_BYTES } from './chat-history';
import { readChatTranscript, requireChatTerminal } from './chat-launch';
import type { AgentChatTranscript } from './chat-provider';
import { claudeHistoryImage } from './claude-history';
import type { AgentChatServiceOptions } from './service-options';

const fullTranscripts = new SingleFlight<string, AgentChatTranscript | undefined>();

/**
 * The original of an image a user message carried, read straight from the provider's on-disk record, so the Client can
 * preview an image a resumed conversation knows only by count. It needs no provider process: opening a Chat must not
 * spawn one per image. Only Claude Code keeps images in a transcript Caxri reads; Codex history comes from its
 * app-server, whose item ids name no on-disk record, so a Codex image stays a placeholder.
 */
export async function readChatImage(
    options: Pick<AgentChatServiceOptions, 'agentEnvironment' | 'database'>,
    terminalId: string,
    itemId: string,
    index: number,
): Promise<Omit<AgentChatImageInput, 'thumbnail'> | null> {
    const { provider } = requireChatTerminal(options.database, terminalId);
    if (provider !== 'claude') return null;
    const tail = await readChatTranscript(options, terminalId);
    if (!tail) return null;
    const recent = claudeHistoryImage(tail.content, itemId, index);
    if (recent || !tail.truncated) return recent ?? null;
    /**
     * Images sit inline as base64, so a few turns of screenshots push an earlier message's line out of the resume tail
     * while its placeholder is still on screen; read as far back as history paging does. A page of placeholders asks at
     * once, so concurrent misses share one read instead of each holding its own copy of the transcript.
     */
    const full = await fullTranscripts.run(terminalId, () =>
        readChatTranscript(options, terminalId, MAX_HISTORY_TRANSCRIPT_BYTES),
    );
    return (full && claudeHistoryImage(full.content, itemId, index)) ?? null;
}

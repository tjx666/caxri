import type { AgentChatImageInput } from '@caxri/protocol';

import { MAX_HISTORY_TRANSCRIPT_BYTES } from './chat-history';
import { readChatTranscript, requireChatTerminal } from './chat-launch';
import { claudeHistoryImage } from './claude-history';
import type { AgentChatServiceOptions } from './service-options';

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
    /**
     * Reads as far back as history paging does, not the resume tail: images sit inline as base64, so a few turns of
     * screenshots push an earlier message's line out of the last 4 MB while its placeholder is still on screen.
     */
    const transcript = await readChatTranscript(options, terminalId, MAX_HISTORY_TRANSCRIPT_BYTES);
    return (transcript && claudeHistoryImage(transcript.content, itemId, index)) ?? null;
}

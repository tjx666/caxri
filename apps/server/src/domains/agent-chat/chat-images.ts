import type { AgentChatImageInput, AgentProvider } from '@caxri/protocol';
import { SingleFlight } from '@caxri/system';

import { MAX_HISTORY_TRANSCRIPT_BYTES } from './chat-history';
import { readChatTranscript, requireChatTerminal } from './chat-launch';
import type { AgentChatTranscript } from './chat-provider';
import { codexHistoryImage } from './codex-input';
import { claudeHistoryImage } from './history/claude-history';
import type { AgentChatServiceOptions } from './service-options';

const fullTranscripts = new SingleFlight<string, AgentChatTranscript | undefined>();

/**
 * Finds one image in a provider's on-disk record, by the user message's item id and the image's position: `undefined`
 * when the record read holds no such message, `null` when it holds the message but not a readable image there.
 */
type HistoryImageReader = (
    transcript: string,
    itemId: string,
    index: number,
) => Omit<AgentChatImageInput, 'thumbnail'> | null | undefined;

/**
 * Providers whose record keeps each sent image inline, under the item id the Chat shows: Claude Code's transcript and
 * Codex's rollout. Grok's is not read, so its images stay placeholders.
 */
const HISTORY_IMAGE_READERS: Partial<Record<AgentProvider, HistoryImageReader>> = {
    claude: claudeHistoryImage,
    codex: codexHistoryImage,
};

/**
 * The original of an image a user message carried, read straight from the provider's on-disk record, so the Client can
 * preview an image a resumed conversation knows only by count. It needs no provider process: opening a Chat must not
 * spawn one per image, and a suspended Chat still shows its images.
 */
export async function readChatImage(
    options: Pick<AgentChatServiceOptions, 'agentEnvironment' | 'database'>,
    terminalId: string,
    itemId: string,
    index: number,
): Promise<Omit<AgentChatImageInput, 'thumbnail'> | null> {
    const { provider } = requireChatTerminal(options.database, terminalId);
    const read = HISTORY_IMAGE_READERS[provider];
    if (!read) return null;
    const tail = await readChatTranscript(options, terminalId);
    if (!tail) return null;
    const recent = read(tail.content, itemId, index);
    // Only a message the tail does not reach is worth the full read; a found one already answered.
    if (recent !== undefined || !tail.truncated) return recent ?? null;
    /**
     * Images sit inline as base64, so a few turns of screenshots push an earlier message's line out of the resume tail
     * while its placeholder is still on screen; read as far back as history paging does. A page of placeholders asks at
     * once, so concurrent misses share one read instead of each holding its own copy of the transcript.
     */
    const full = await fullTranscripts.run(terminalId, () =>
        readChatTranscript(options, terminalId, MAX_HISTORY_TRANSCRIPT_BYTES),
    );
    return (full && read(full.content, itemId, index)) ?? null;
}

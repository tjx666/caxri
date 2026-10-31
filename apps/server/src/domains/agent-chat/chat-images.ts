import type { AgentChatImageInput, AgentChatImagePending, AgentProvider } from '@caxri/protocol';
import { SingleFlight } from '@caxri/system';

import { readChatTranscript, requireChatTerminal } from './chat-launch';
import type { AgentChatTranscript } from './chat-provider';
import { claudeHistoryImage } from './history/claude-history';
import { MAX_HISTORY_TRANSCRIPT_BYTES } from './history/read';
import { codexHistoryImage } from './providers/codex/input';
import type { AgentChatServiceOptions } from './service-options';

const PENDING: AgentChatImagePending = { pending: true };

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
 * spawn one per image, and a suspended Chat still shows its images. A message the record does not hold yet answers
 * `pending`: Claude Code writes a message sent mid-turn only once the running turn takes it in, while the Chat already
 * shows it, so the Client asks again instead of settling on "unavailable".
 */
export async function readChatImage(
    options: Pick<AgentChatServiceOptions, 'agentEnvironment' | 'database'>,
    terminalId: string,
    itemId: string,
    index: number,
): Promise<Omit<AgentChatImageInput, 'thumbnail'> | AgentChatImagePending | null> {
    const { provider } = requireChatTerminal(options.database, terminalId);
    const read = HISTORY_IMAGE_READERS[provider];
    if (!read) return null;
    const tail = await readChatTranscript(options, terminalId);
    if (!tail) return null;
    const recent = read(tail.content, itemId, index);
    // Only a message the tail does not reach is worth the full read; a found one already answered.
    if (recent !== undefined) return recent;
    if (!tail.truncated) return PENDING;
    /**
     * Images sit inline as base64, so a few turns of screenshots push an earlier message's line out of the resume tail
     * while its placeholder is still on screen; read as far back as history paging does. A page of placeholders asks at
     * once, so concurrent misses share one read instead of each holding its own copy of the transcript.
     */
    const full = await fullTranscripts.run(terminalId, () =>
        readChatTranscript(options, terminalId, MAX_HISTORY_TRANSCRIPT_BYTES),
    );
    if (!full) return null;
    return read(full.content, itemId, index) ?? PENDING;
}

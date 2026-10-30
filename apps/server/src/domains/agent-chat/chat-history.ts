import type { AgentChatHistoryPage, AgentChatItem, AgentChatTurn } from '@caxri/protocol';
import { agentChatHistoryPageSchema } from '@caxri/protocol';

import { chatHistoryPageStart, chatHistoryTurns } from './chat-history-archive';
import { readChatTranscript, requireChatTerminal } from './chat-launch';
import type { ChatProjection } from './chat-projection';
import type { ChatStates } from './chat-states';
import { claudeHistoryItems } from './history/claude-history';
import type { AgentChatServiceOptions } from './service-options';

/**
 * How much of a Claude Code transcript one paging read parses. Resume reads only the bounded tail; scrolling back past
 * it reads this much. Images are stored inline as base64, so a transcript of a few hundred turns can reach tens of
 * megabytes.
 */
export const MAX_HISTORY_TRANSCRIPT_BYTES = 128 * 1024 * 1024;

/**
 * How long a parsed transcript stays cached after its last page. Scrolling back reads one page after another, and
 * re-parsing tens of megabytes for each would stall every page.
 */
const PARSED_TRANSCRIPT_TTL_MS = 60_000;

interface ParsedTranscript {
    historyId: string;
    items: AgentChatItem[];
    turns: Map<string, AgentChatTurn>;
    /**
     * The transcript went back further than {@link MAX_HISTORY_TRANSCRIPT_BYTES}.
     */
    isTruncated: boolean;
    expiry: NodeJS.Timeout;
}

/**
 * Parsed transcripts by Terminal. Records before a cursor never change in an append-only transcript, so a parse stays
 * valid for the history it was read for; a replaced history (`historyId`) parses again, because a rewind may have moved
 * the conversation onto another branch. This is a retained, TTL-bound cache, not a `SingleFlight`, which forgets a load
 * as soon as it settles.
 */
const parsed = new Map<string, Promise<ParsedTranscript | undefined>>();

async function parseTranscript(
    options: Pick<AgentChatServiceOptions, 'agentEnvironment' | 'database'>,
    terminalId: string,
    historyId: string,
): Promise<ParsedTranscript | undefined> {
    const cached = await parsed.get(terminalId);
    if (cached?.historyId === historyId) {
        cached.expiry.refresh();
        return cached;
    }
    const pending = (async (): Promise<ParsedTranscript | undefined> => {
        const transcript = await readChatTranscript(
            options,
            terminalId,
            MAX_HISTORY_TRANSCRIPT_BYTES,
        );
        if (!transcript) return undefined;
        const { items, turns } = claudeHistoryItems(transcript.content);
        const expiry = setTimeout(() => parsed.delete(terminalId), PARSED_TRANSCRIPT_TTL_MS);
        expiry.unref();
        return {
            historyId,
            items,
            turns: new Map(turns.map((turn) => [turn.id, turn])),
            isTruncated: transcript.truncated,
            expiry,
        };
    })();
    if (cached) clearTimeout(cached.expiry);
    parsed.set(terminalId, pending);
    try {
        const result = await pending;
        // Nothing to page through is not cached: there is no expiry to release it, and a transcript may appear later.
        if (!result && parsed.get(terminalId) === pending) parsed.delete(terminalId);
        return result;
    } catch (error) {
        // A failed read is not cached; the next page tries again.
        if (parsed.get(terminalId) === pending) parsed.delete(terminalId);
        throw error;
    }
}

/**
 * The page before `beforeItemId` read from the provider's own record. Only Claude Code keeps a transcript Caxri can
 * page through; Codex and Grok replay their whole history on resume, so their archive already holds everything the
 * Server Core budget kept.
 */
async function readRecordPage(
    options: Pick<AgentChatServiceOptions, 'agentEnvironment' | 'database'>,
    terminalId: string,
    historyId: string,
    beforeItemId: string,
): Promise<Omit<AgentChatHistoryPage, 'historyId'>> {
    const unavailable = { items: [], turns: [], hasMore: false, truncated: true };
    const { provider } = requireChatTerminal(options.database, terminalId);
    if (provider !== 'claude') return unavailable;
    const transcript = await parseTranscript(options, terminalId, historyId);
    const end = transcript?.items.findIndex((item) => item.id === beforeItemId) ?? -1;
    if (!transcript || end === -1) return unavailable;
    const start = chatHistoryPageStart(transcript.items, end);
    const items = transcript.items.slice(start, end);
    return {
        items,
        turns: chatHistoryTurns(items, (turnId) => transcript.turns.get(turnId)),
        hasMore: start > 0,
        truncated: start === 0 && transcript.isTruncated,
    };
}

/**
 * One page of the history older than `beforeItemId`: first from the items Server Core archived as they left the
 * projection, then, past the archive, from the provider's own record.
 */
export async function readChatHistoryPage(
    options: Pick<AgentChatServiceOptions, 'agentEnvironment' | 'database'>,
    projection: ChatProjection,
    beforeItemId: string,
): Promise<AgentChatHistoryPage> {
    const { snapshot, history } = projection;
    const historyId = snapshot.historyId ?? '';
    const page = history.page(beforeItemId, snapshot.items[0]?.id);
    if (page && page.items.length > 0)
        return {
            historyId,
            ...page,
            hasMore: page.hasMore || history.isIncomplete,
            truncated: false,
        };
    if (!history.isIncomplete)
        return { historyId, items: [], turns: [], hasMore: false, truncated: false };
    // Past the archive's oldest item, or before an item an earlier record page returned.
    return {
        historyId,
        ...(await readRecordPage(options, snapshot.terminalId, historyId, beforeItemId)),
    };
}

/**
 * One Chat Terminal's page of history before `beforeItemId`, with the projection's pending items archived first.
 * Reading history never starts a provider process.
 */
export async function readChatTerminalHistory(
    options: Pick<AgentChatServiceOptions, 'agentEnvironment' | 'database'>,
    states: ChatStates,
    terminalId: string,
    beforeItemId: string,
): Promise<AgentChatHistoryPage> {
    requireChatTerminal(options.database, terminalId);
    const state = states.open(terminalId);
    state.projection.flush();
    return agentChatHistoryPageSchema.parse(
        await readChatHistoryPage(options, state.projection, beforeItemId),
    );
}

import type { AgentChatRequest, AgentExcerpt } from '@caxri/protocol';
import { AGENT_EXCERPT_MAX_LENGTH } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import { clipToLength, summarizeLatestAgentReply, toPlainLine } from './reply-summary';
import type { AgentTimelineService } from './timeline';

/**
 * Enough recent items to reach back past a burst of tool calls to the turn's closing message.
 */
const EXCERPT_TIMELINE_ITEMS = 40;

/**
 * What a pending provider request asks, as one plain line: the first question's text, or the action to approve.
 */
function describePendingRequest(request: AgentChatRequest): string | undefined {
    switch (request.kind) {
        case 'question': {
            return toPlainLine(request.questions.at(0)?.question ?? '') || undefined;
        }
        case 'command': {
            const line = toPlainLine(request.reason ?? request.command ?? '');
            return line || undefined;
        }
        case 'fileChange': {
            return toPlainLine(request.reason ?? '') || undefined;
        }
        case 'tool': {
            return (
                toPlainLine(request.reason ?? `${request.name} ${request.summary ?? ''}`) ||
                undefined
            );
        }
    }
}

export interface AgentExcerptSources {
    database: CaxriDatabase;
    timeline: AgentTimelineService;
    /**
     * The first request a live Chat is waiting on, read from its in-memory projection. It must not start a provider.
     */
    pendingRequest: (terminalId: string) => AgentChatRequest | undefined;
    /**
     * A live Chat's current away recap (`currentAgentChatAwayRecap`), read from its in-memory projection.
     */
    awayRecap: (terminalId: string) => string | undefined;
}

/**
 * Excerpts for the asked Sessions. A Session waiting on the user shows what it asked when its Chat is live; a live Chat
 * that replied while the user was away shows its recap; every other case shows the closing message of its latest turn
 * from the on-disk transcript. Terminal Agents have no live request to read, so they only ever get the transcript's
 * reply. Nothing here starts a provider, and no text is logged.
 */
export async function readAgentExcerpts(
    sources: AgentExcerptSources,
    sessions: ReadonlyArray<{ sessionId: string; attentionGeneration: number }>,
): Promise<Record<string, AgentExcerpt>> {
    const entries = await Promise.all(
        sessions.map(async ({ sessionId, attentionGeneration }) => {
            const session = sources.database.getSession(sessionId);
            const terminalId = session?.primaryAgentTerminalId;
            if (!session || !terminalId || session.attentionGeneration !== attentionGeneration)
                return;
            const request = sources.pendingRequest(terminalId);
            const asked = request && describePendingRequest(request);
            if (asked)
                return [
                    sessionId,
                    { kind: 'request', text: clipToLength(asked, AGENT_EXCERPT_MAX_LENGTH) },
                ] as const;
            const recap = sources.awayRecap(terminalId);
            if (recap) return [sessionId, { kind: 'recap', text: recap }] as const;
            const page = await sources.timeline.read(
                sessionId,
                terminalId,
                undefined,
                EXCERPT_TIMELINE_ITEMS,
            );
            if (page.status !== 'available') return;
            const text = summarizeLatestAgentReply(page.items, AGENT_EXCERPT_MAX_LENGTH);
            return text === undefined ? undefined : ([sessionId, { kind: 'reply', text }] as const);
        }),
    );
    const excerpts: Record<string, AgentExcerpt> = {};
    for (const entry of entries) if (entry) excerpts[entry[0]] = entry[1];
    return excerpts;
}

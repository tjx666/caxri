import type { AgentTimelineItem } from '@caxri/protocol';
import { AGENT_REPLY_SUMMARY_MAX_LENGTH } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import type { AgentTimelineService } from './timeline';

/**
 * Enough recent items to reach back past a burst of tool calls to the turn's closing message.
 */
const SUMMARY_TIMELINE_ITEMS = 40;

/**
 * Flattens Markdown into one readable line: a banner renders plain text, so fences, headings, emphasis, and link syntax
 * would otherwise show up as literal punctuation.
 */
function toPlainLine(text: string): string {
    return text
        .replaceAll(/```[\s\S]*?(?:```|$)/gu, ' ')
        .replaceAll(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
        .replaceAll(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gmu, '')
        .replaceAll(/(\*\*|__|`)/gu, '')
        .replaceAll(/\s+/gu, ' ')
        .trim();
}

/**
 * The turn's closing Agent message, cut to a single banner line. Only a message after the latest user message counts,
 * so a turn that ended on a tool call or with no text never resurfaces the previous turn's answer.
 */
export function summarizeLatestAgentReply(items: readonly AgentTimelineItem[]): string | undefined {
    for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index];
        if (item.type === 'userMessage') return undefined;
        if (item.type !== 'agentMessage') continue;
        const line = toPlainLine(item.text);
        if (!line) continue;
        const characters = [...line];
        return characters.length <= AGENT_REPLY_SUMMARY_MAX_LENGTH
            ? line
            : `${characters
                  .slice(0, AGENT_REPLY_SUMMARY_MAX_LENGTH - 1)
                  .join('')
                  .trimEnd()}…`;
    }
    return undefined;
}

/**
 * Reads the Primary Agent's latest reply through the same bounded transcript projection the mobile Conversation uses.
 * Providers without a timeline parser, Shell-only Sessions, and missing transcripts all answer with no summary so the
 * caller falls back to content-free copy.
 */
export async function readAgentReplySummary(
    database: CaxriDatabase,
    timeline: AgentTimelineService,
    sessionId: string,
): Promise<{ summary?: string }> {
    const terminalId = database.getSession(sessionId)?.primaryAgentTerminalId;
    if (!terminalId) return {};
    const page = await timeline.read(sessionId, terminalId, undefined, SUMMARY_TIMELINE_ITEMS);
    if (page.status !== 'available') return {};
    const summary = summarizeLatestAgentReply(page.items);
    return summary === undefined ? {} : { summary };
}

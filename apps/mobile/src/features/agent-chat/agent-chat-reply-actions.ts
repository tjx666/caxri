import type { AgentChatSnapshot, AppLocale } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { agentChatMessageEditAvailability } from './agent-chat-message-edit';

type ReplySnapshot = Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'operation' | 'turns'>;

/**
 * Whether a reply action can run now, or the reason it cannot, shown under the dimmed menu row.
 */
export type AgentChatReplyAvailability = { canRun: true } | { canRun: false; reason: string };

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(timestamp: number): number {
    const date = new Date(timestamp);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * When a reply was sent, as its More menu heads itself: `Today 17:59`, `Yesterday 09:12`, `Oct 3 17:59`, or with the
 * year once it is from another year, the way Desktop labels a Chat's days. `now` decides what "today" is.
 */
export function agentChatReplyTime(
    timestamp: number,
    now: number,
    locale: AppLocale,
    t: Translate,
): string {
    const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(
        timestamp,
    );
    const days = Math.round((startOfDay(now) - startOfDay(timestamp)) / DAY_MS);
    if (days === 0) return t('chat.reply.today', { time });
    if (days === 1) return t('chat.reply.yesterday', { time });
    const isSameYear = new Date(timestamp).getFullYear() === new Date(now).getFullYear();
    const date = new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        ...(!isSameYear && { year: 'numeric' }),
    }).format(timestamp);
    return `${date} ${time}`;
}

/**
 * The user message that started turn `turnId`, which Retry sends again.
 */
function turnPromptId(snapshot: ReplySnapshot, turnId: string): string | undefined {
    return snapshot.items.find((item) => item.type === 'userMessage' && item.turnId === turnId)?.id;
}

/**
 * Retry on a reply: the message that started its turn, sent again in its place through "Edit from Here", which replaces
 * this turn and every later one (Server Core keeps them as an earlier version). It is refused for the same reasons the
 * edit is, and when the turn's message is not in what the phone holds.
 */
export function agentChatReplyRetry(
    snapshot: ReplySnapshot | undefined,
    turnId: string,
    t: Translate,
): { itemId: string; availability: AgentChatReplyAvailability } | undefined {
    const itemId = snapshot && turnPromptId(snapshot, turnId);
    if (!itemId) return undefined;
    const edit = agentChatMessageEditAvailability(snapshot, itemId, t);
    return {
        itemId,
        availability: edit.canEdit ? { canRun: true } : { canRun: false, reason: edit.reason },
    };
}

/**
 * Fork in New Chat on a reply: a new Session holding the conversation through this reply's turn. Server Core forks
 * before a user message, so the fork names the message that started the next turn, or nothing for the latest turn (the
 * whole conversation). Refused while a turn runs, as Server Core would refuse it.
 */
export function agentChatReplyFork(
    snapshot: ReplySnapshot | undefined,
    turnId: string,
    t: Translate,
): { itemId?: string; availability: AgentChatReplyAvailability } {
    if (!snapshot)
        return { availability: { canRun: false, reason: t('chat.reply.forkUnavailable') } };
    if (snapshot.activeTurnId || snapshot.operation === 'compacting')
        return { availability: { canRun: false, reason: t('chat.reply.stopToFork') } };
    const position = snapshot.turns.findIndex((turn) => turn.id === turnId);
    if (position === -1)
        return { availability: { canRun: false, reason: t('chat.reply.forkUnavailable') } };
    const next = snapshot.turns.at(position + 1);
    if (!next) return { availability: { canRun: true } };
    const itemId = turnPromptId(snapshot, next.id);
    return itemId
        ? { itemId, availability: { canRun: true } }
        : { availability: { canRun: false, reason: t('chat.reply.forkUnavailable') } };
}

/**
 * A source's site as its row names it: the host without `www.`.
 */
export function agentChatSourceHost(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./u, '');
    } catch {
        return url;
    }
}

/**
 * Where a source's site icon loads from: its site's `/favicon.ico`, for HTTPS pages only. The phone requests it
 * directly, and the pages come from what an Agent read off the web, so a plain-HTTP or malformed address (which may
 * name a host on the user's own network) shows the globe instead, as MCP server icons only load over HTTPS.
 */
export function agentChatSourceFavicon(url: string): string | undefined {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' ? `${parsed.origin}/favicon.ico` : undefined;
    } catch {
        return undefined;
    }
}

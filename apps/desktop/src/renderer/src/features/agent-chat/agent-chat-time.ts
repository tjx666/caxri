import type { AgentChatTimelineEntry } from './agent-chat-timeline';

/**
 * Clock time in the user's locale (`17:59`, or `5:59 PM` where the locale uses a 12-hour clock).
 */
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const MONTH_DAY_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const FULL_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
});
const FULL_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'medium' });

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(timestamp: number): number {
    const date = new Date(timestamp);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * When a message was sent, as the clock time beside it: `17:59`.
 */
export function agentChatMessageTime(timestamp: number): string {
    return TIME_FORMAT.format(timestamp);
}

/**
 * The full date and time a message's clock time stands for, for its tooltip.
 */
export function agentChatMessageFullTime(timestamp: number): string {
    return FULL_FORMAT.format(timestamp);
}

/**
 * The day break above the first message of a day: `Today 17:59`, `Yesterday 09:12`, `Oct 3 17:59`, or with the year
 * once the message is from another year. `now` decides what "today" is, so a caller re-renders it as days turn over.
 */
export function agentChatDayLabel(timestamp: number, now: number): string {
    const time = agentChatMessageTime(timestamp);
    const days = Math.round((startOfDay(now) - startOfDay(timestamp)) / DAY_MS);
    if (days === 0) return `Today ${time}`;
    if (days === 1) return `Yesterday ${time}`;
    const isSameYear = new Date(timestamp).getFullYear() === new Date(now).getFullYear();
    return `${(isSameYear ? MONTH_DAY_FORMAT : FULL_DATE_FORMAT).format(timestamp)} ${time}`;
}

/**
 * The user messages that open a new day of the conversation, keyed by item id with the time to label the break by. The
 * first dated message always opens one, so a conversation says when it began, the way the Codex app heads its
 * transcript; a message without a time neither gets a break nor starts a day.
 */
export function agentChatDayBreaks(
    timeline: readonly AgentChatTimelineEntry[],
): ReadonlyMap<string, number> {
    const breaks = new Map<string, number>();
    let previousDay: number | undefined;
    for (const entry of timeline) {
        if (entry.kind !== 'item' || entry.item.type !== 'userMessage') continue;
        const { createdAt } = entry.item;
        if (createdAt === undefined) continue;
        const day = startOfDay(createdAt);
        if (day !== previousDay) breaks.set(entry.item.id, createdAt);
        previousDay = day;
    }
    return breaks;
}

import type { TranslationParameters } from '../configuration/i18n-interpolate.js';
import { interpolate } from '../configuration/i18n-interpolate.js';
import { agentChatLabelsEn } from './agent-chat-labels-en.js';

/**
 * A key of the shared Agent Chat presentation catalog ({@link agentChatLabelsEn}).
 */
export type AgentChatLabelKey = keyof typeof agentChatLabelsEn;

/**
 * Translates a catalog key in the reader's language. Desktop and the phone pass their own `t`, whose dictionaries
 * spread the catalog; a client's wider key union still satisfies this narrower parameter.
 */
export type AgentChatLabelTranslate = (
    key: AgentChatLabelKey,
    parameters?: TranslationParameters,
) => string;

/**
 * The English translator every presentation function defaults to, so the CLI, Server Core, and tests that pass no `t`
 * keep reading the English source text.
 */
export const translateAgentChatLabel: AgentChatLabelTranslate = (key, parameters) =>
    interpolate(agentChatLabelsEn[key], parameters);

/**
 * Whether a key assembled at runtime (a provider and mode pair) exists in the catalog.
 */
export const isAgentChatLabelKey = (key: string): key is AgentChatLabelKey =>
    Object.hasOwn(agentChatLabelsEn, key);

/**
 * The whole minutes and seconds {@link formatShortDuration} writes, for a surface that animates them separately.
 */
export function shortDurationParts(durationMs: number): { minutes: number; seconds: number } {
    const total = Math.round(durationMs / 1000);
    return { minutes: Math.floor(total / 60), seconds: total % 60 };
}

/**
 * A short elapsed time for a finished Agent turn or tool call: `<1s`, `45s`, `2m`, `2m 1s` (`2 分钟 1 秒` in Chinese, as
 * the Codex app writes it). Rounds to whole seconds because the reader compares turns, not milliseconds. Returns `null`
 * when no duration was recorded.
 */
export function formatShortDuration(
    durationMs: number | undefined,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string | null {
    if (durationMs === undefined) return null;
    const { minutes, seconds } = shortDurationParts(durationMs);
    if (minutes === 0 && seconds === 0) return t('agentChat.fold.durationUnderOneSecond');
    if (minutes === 0) return t('agentChat.fold.durationSeconds', { seconds });
    if (seconds === 0) return t('agentChat.fold.durationMinutes', { minutes });
    return t('agentChat.fold.durationMinutesSeconds', { minutes, seconds });
}

/**
 * Below this an elapsed time is not worth showing: it would read `<1s` and then jump straight to `1s`.
 */
const NOTICEABLE_DURATION_MS = 1000;

/**
 * Whether an elapsed time is long enough to show; see `NOTICEABLE_DURATION_MS`.
 */
export function isNoticeableDuration(durationMs: number | undefined): durationMs is number {
    return durationMs !== undefined && durationMs >= NOTICEABLE_DURATION_MS;
}

/**
 * `formatShortDuration` once the time is noticeable, else `null`. Every Agent Chat surface that shows how long a turn,
 * a work row, a running turn, or a background task took drops sub-second times through this, so a row of `<1s` labels
 * never says something a reader cannot act on.
 */
export function formatNoticeableDuration(
    durationMs: number | undefined,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string | null {
    return isNoticeableDuration(durationMs) ? formatShortDuration(durationMs, t) : null;
}

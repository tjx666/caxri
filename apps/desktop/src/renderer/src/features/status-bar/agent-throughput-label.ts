import type { AgentThroughputAggregate, AgentThroughputSample } from '@caxri/protocol';

/**
 * The shortest duration a rate is computed from. Transcript timestamps are coarse, so a response measured in a few
 * milliseconds divided its tokens by almost nothing and printed `40,000 tok/s`; below this floor the token count is
 * still reported, without a rate.
 */
const MIN_THROUGHPUT_DURATION_MS = 250;

/**
 * Output tokens per second over a token-weighted total. Undefined when nothing was measured or the duration is below
 * {@link MIN_THROUGHPUT_DURATION_MS}.
 */
export function throughputRate(
    aggregate: Pick<AgentThroughputAggregate, 'durationMs' | 'outputTokens'>,
): number | undefined {
    if (aggregate.durationMs < MIN_THROUGHPUT_DURATION_MS || aggregate.outputTokens <= 0)
        return undefined;
    return aggregate.outputTokens / (aggregate.durationMs / 1_000);
}

const groupedCount = new Intl.NumberFormat('en-US');

/**
 * Joins a number to its unit so a wrapping line or a narrow tile never strands `tok/s` away from its value.
 */
const NO_BREAK_SPACE = '\u{A0}';

/**
 * Whole tokens per second, `<1` below one. A decimal place flickered on every 2s poll and changed the chip's width
 * between `9.8` and `10`, while the tenth carries no decision a user makes.
 */
export function formatThroughputRate(rate: number): string {
    return `${rate < 1 ? '<1' : groupedCount.format(Math.round(rate))}${NO_BREAK_SPACE}tok/s`;
}

/**
 * The spoken form of {@link formatThroughputRate} for accessible names: `62 tokens per second`.
 */
export function spokenThroughputRate(rate: number): string {
    if (rate < 1) return 'less than 1 token per second';
    const rounded = Math.round(rate);
    return `${groupedCount.format(rounded)} ${rounded === 1 ? 'token' : 'tokens'} per second`;
}

/**
 * The one phrase every surface (status-bar chip, its hover card, the Agent status tab) uses for the headline figure:
 * `Average of the last 12 responses`.
 */
export function recentAverageLabel(responseCount: number): string {
    return responseCount === 1
        ? 'Last response only'
        : `Average of the last ${responseCount} responses`;
}

/**
 * True when two totals cover the same responses, so a card can show one row instead of two identical ones (the first
 * turn of an Agent Session is the whole Agent Session).
 */
export function isSameThroughputAggregate(
    left: AgentThroughputAggregate,
    right: AgentThroughputAggregate,
): boolean {
    return (
        left.responseCount === right.responseCount &&
        left.outputTokens === right.outputTokens &&
        left.durationMs === right.durationMs
    );
}

/**
 * `9.5s` below ten seconds, `42s` below a minute, `1m 5s` above. Units sit flush against their number everywhere, so
 * the card's rows read in one format.
 */
export function formatThroughputDuration(milliseconds: number): string {
    const seconds = milliseconds / 1_000;
    if (seconds < 10 && seconds.toFixed(1) !== '10.0') return `${seconds.toFixed(1)}s`;
    const whole = Math.round(seconds);
    return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

/**
 * `3,210 tokens in 52s · 62 tok/s`, with the response count when more than one response is folded in.
 */
export function describeThroughputAggregate(aggregate: AgentThroughputAggregate): string {
    const rate = throughputRate(aggregate);
    const responses =
        aggregate.responseCount > 1 ? ` across ${aggregate.responseCount} responses` : '';
    return `${groupedCount.format(aggregate.outputTokens)} tokens in ${formatThroughputDuration(aggregate.durationMs)}${responses}${rate === undefined ? '' : ` · ${formatThroughputRate(rate)}`}`;
}

export function describeThroughputSample(sample: AgentThroughputSample): string {
    return describeThroughputAggregate({ ...sample, responseCount: 1 });
}

export const AGENT_THROUGHPUT_METHOD_NOTE =
    "Output tokens divided by each request's time, read from the Agent's own transcript. Includes waiting for the first token; excludes tool execution.";

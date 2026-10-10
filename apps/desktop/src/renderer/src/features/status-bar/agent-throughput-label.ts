import type { AgentThroughputAggregate, AgentThroughputSample } from '@caxri/protocol';

/**
 * Output tokens per second over a token-weighted total. Undefined when nothing was measured.
 */
export function throughputRate(
    aggregate: Pick<AgentThroughputAggregate, 'durationMs' | 'outputTokens'>,
): number | undefined {
    if (aggregate.durationMs <= 0 || aggregate.outputTokens <= 0) return undefined;
    return aggregate.outputTokens / (aggregate.durationMs / 1_000);
}

/**
 * Whole tokens per second once the rate is large enough that a decimal is noise, one decimal below that.
 */
export function formatThroughputRate(rate: number): string {
    return `${rate < 10 ? rate.toFixed(1) : Math.round(rate)} tok/s`;
}

export function formatThroughputDuration(milliseconds: number): string {
    const seconds = milliseconds / 1_000;
    if (seconds < 10) return `${seconds.toFixed(1)} s`;
    const whole = Math.round(seconds);
    return whole < 60 ? `${whole} s` : `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

const tokenCount = new Intl.NumberFormat('en-US');

/**
 * `3,210 tokens in 52 s · 62 tok/s`, with the response count when more than one response is folded in.
 */
export function describeThroughputAggregate(aggregate: AgentThroughputAggregate): string {
    const rate = throughputRate(aggregate);
    const responses =
        aggregate.responseCount > 1 ? ` across ${aggregate.responseCount} responses` : '';
    return `${tokenCount.format(aggregate.outputTokens)} tokens in ${formatThroughputDuration(aggregate.durationMs)}${responses}${rate === undefined ? '' : ` · ${formatThroughputRate(rate)}`}`;
}

export function describeThroughputSample(sample: AgentThroughputSample): string {
    return describeThroughputAggregate({ ...sample, responseCount: 1 });
}

export const AGENT_THROUGHPUT_METHOD_NOTE =
    "Output tokens divided by each request's time, read from the Agent's own transcript. Includes waiting for the first token; excludes tool execution.";

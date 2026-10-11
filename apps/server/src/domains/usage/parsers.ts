import type { AgentProvider } from '@caxri/protocol';

import type { TranscriptPullRequestScan } from '../agents';
import { createTranscriptPullRequestScan, scanTranscriptPullRequestLine } from '../agents';
import type { RateLimitObservation, UsageAccumulator, UsageTokens } from './accumulator';

/**
 * Consumes one transcript file line by line. Every parser is streaming: usage reaches the accumulator as soon as its
 * line is read, so a snapshot taken between lines is exact and a live tail can keep feeding the same parser. `finish`
 * marks the end of the file so the next file's first record never extends this one's active time.
 */
export interface UsageLineParser {
    line(text: string): void;
    finish(): void;
}

export interface UsageParserOptions {
    /**
     * Subagent side files contribute tokens but not active time: they run concurrently with the main transcript, so
     * their gaps would double count wall-clock time.
     */
    isSideStream?: boolean;
    /**
     * The file continues a conversation recorded in another file (a reverted Codex thread's `<thread>_<rollout>`
     * rollout), so its first cumulative total repeats usage that file already holds and only sets the baseline.
     */
    isContinuation?: boolean;
}

/**
 * Matches the record-level ISO timestamp. A literal inside string content is escaped (`\"timestamp\":\"`), so only the
 * record's own key matches.
 */
const ISO_TIMESTAMP_PATTERN = /"timestamp":"(\d{4}-\d{2}-\d{2}T[^"]+)"/;
const EPOCH_SECONDS_PATTERN = /^\{"timestamp":(\d{9,11})[,}]/;

function isoTimestamp(text: string): number | undefined {
    const match = ISO_TIMESTAMP_PATTERN.exec(text);
    if (!match) return;
    const at = Date.parse(match[1]);
    return Number.isFinite(at) ? at : undefined;
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function number(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function string(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined;
}

/**
 * Feeds the shared pull request scanner and records every newly created PR, not only the latest one the sidebar needs.
 */
function pullRequestTracker(accumulator: UsageAccumulator): (text: string) => void {
    const scan: TranscriptPullRequestScan = createTranscriptPullRequestScan();
    let lastCreated: string | undefined;
    return (text) => {
        scanTranscriptPullRequestLine(text, scan);
        const created = scan.created?.url;
        if (created && created !== lastCreated) {
            lastCreated = created;
            accumulator.addPullRequest(created);
        }
    };
}

interface ClaudeMessageUsage {
    at: number;
    model: string;
    usage: UsageTokens;
}

/**
 * Claude Code writes one record per streamed content block, each repeating the message's `usage` as it grows. Records
 * are therefore merged per message ID with a per-field maximum, the same rule `collectClaudeUsage` uses for delegation
 * results; summing them would multiply-count every multi-block reply. A repeat adds only its growth over the maximum
 * seen so far, attributed to the message's first record.
 */
export function claudeUsageParser(
    accumulator: UsageAccumulator,
    options: UsageParserOptions = {},
): UsageLineParser {
    const messages = new Map<string, ClaudeMessageUsage>();
    const trackPullRequests = pullRequestTracker(accumulator);
    let anonymous = 0;
    return {
        line(text) {
            const at = isoTimestamp(text);
            if (at !== undefined && !options.isSideStream) accumulator.markActivity(at);
            trackPullRequests(text);
            if (at === undefined || !text.includes('"usage"') || !text.includes('"assistant"'))
                return;
            const entry = record(parseJson(text));
            if (entry?.type !== 'assistant') return;
            const message = record(entry.message);
            const usage = record(message?.usage);
            const model = string(message?.model);
            if (!message || !usage || !model || model === '<synthetic>') return;
            const cacheCreation = record(usage.cache_creation);
            const cacheWrite = number(usage.cache_creation_input_tokens);
            const next: UsageTokens = {
                input: number(usage.input_tokens),
                output: number(usage.output_tokens),
                cacheRead: number(usage.cache_read_input_tokens),
                cacheWrite,
                cacheWrite1h: Math.min(
                    cacheWrite,
                    number(cacheCreation?.ephemeral_1h_input_tokens),
                ),
                reasoning: 0,
            };
            const id =
                string(message.id) ?? string(entry.requestId) ?? `anonymous-${(anonymous += 1)}`;
            const previous = messages.get(id);
            if (!previous) {
                messages.set(id, { at, model, usage: next });
                accumulator.addUsage(at, model, next);
                return;
            }
            const growth = { ...next };
            for (const key of Object.keys(next) as Array<keyof UsageTokens>) {
                growth[key] = Math.max(0, next[key] - previous.usage[key]);
                previous.usage[key] = Math.max(previous.usage[key], next[key]);
            }
            accumulator.addUsage(previous.at, previous.model, growth);
        },
        finish() {
            accumulator.endStream();
        },
    };
}

interface CodexTotals {
    input: number;
    cached: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
}

function codexTotals(value: unknown): CodexTotals | undefined {
    const totals = record(value);
    if (!totals) return;
    return {
        input: number(totals.input_tokens),
        cached: number(totals.cached_input_tokens),
        cacheWrite: number(totals.cache_write_input_tokens),
        output: number(totals.output_tokens),
        reasoning: number(totals.reasoning_output_tokens),
    };
}

function codexRateLimits(value: unknown, at: number): RateLimitObservation | undefined {
    const limits = record(value);
    if (!limits) return;
    const windows = [limits.primary, limits.secondary].flatMap((candidate) => {
        const window = record(candidate);
        if (!window || typeof window.used_percent !== 'number') return [];
        const resetsAt = number(window.resets_at);
        return [
            {
                windowMinutes: Math.round(number(window.window_minutes)),
                usedPercent: Math.min(100, Math.max(0, window.used_percent)),
                ...(resetsAt > 0 && { resetsAt: Math.round(resetsAt * 1000) }),
            },
        ];
    });
    if (windows.length === 0) return;
    return { observedAt: at, planType: string(limits.plan_type), windows };
}

/**
 * Codex `token_count` events carry the thread's cumulative `total_token_usage`, repeated whenever rate limits refresh,
 * so usage is the delta between consecutive totals. A total that shrinks only resets the baseline: attributing the
 * whole new total would double count history it may repeat. Codex counts cached input inside `input_tokens` and
 * reasoning inside `output_tokens`.
 */
export function codexUsageParser(
    accumulator: UsageAccumulator,
    options: UsageParserOptions = {},
): UsageLineParser {
    const trackPullRequests = pullRequestTracker(accumulator);
    let model = 'unknown';
    let previous: CodexTotals | undefined;
    return {
        line(text) {
            const at = isoTimestamp(text);
            if (at !== undefined) accumulator.markActivity(at);
            trackPullRequests(text);
            if (at === undefined) return;
            const isTurnContext = text.includes('"turn_context"');
            if (!isTurnContext && !text.includes('"token_count"')) return;
            const entry = record(parseJson(text));
            const payload = record(entry?.payload);
            if (!payload) return;
            if (entry?.type === 'turn_context') {
                model = string(payload.model) ?? model;
                return;
            }
            if (entry?.type !== 'event_msg' || payload.type !== 'token_count') return;
            const limits = codexRateLimits(payload.rate_limits, at);
            if (limits) accumulator.observeRateLimits(limits);
            const totals = codexTotals(record(payload.info)?.total_token_usage);
            if (!totals) return;
            const base = previous;
            previous = totals;
            if (!base && options.isContinuation) return;
            if (base && (totals.input < base.input || totals.output < base.output)) return;
            const delta = (key: keyof CodexTotals) => totals[key] - (base?.[key] ?? 0);
            const cached = Math.max(0, delta('cached'));
            accumulator.addUsage(at, model, {
                input: Math.max(0, delta('input') - cached),
                output: Math.max(0, delta('output')),
                cacheRead: cached,
                cacheWrite: Math.max(0, delta('cacheWrite')),
                cacheWrite1h: 0,
                reasoning: Math.max(0, delta('reasoning')),
            });
        },
        finish() {
            accumulator.endStream();
        },
    };
}

/**
 * Grok reports exact per-prompt usage on `turn_completed`, broken down by model. Its `inputTokens` includes cache reads
 * and writes.
 */
export function grokUsageParser(accumulator: UsageAccumulator): UsageLineParser {
    const seenPrompts = new Set<string>();
    return {
        line(text) {
            const seconds = EPOCH_SECONDS_PATTERN.exec(text)?.[1];
            const at = seconds ? Number(seconds) * 1000 : undefined;
            if (at !== undefined) accumulator.markActivity(at);
            if (at === undefined || !text.includes('"turn_completed"')) return;
            const parameters = record(record(parseJson(text))?.params);
            const update = record(parameters?.update);
            if (update?.sessionUpdate !== 'turn_completed') return;
            const promptId = string(update.prompt_id);
            if (promptId) {
                if (seenPrompts.has(promptId)) return;
                seenPrompts.add(promptId);
            }
            const usage = record(update.usage);
            const byModel = record(usage?.modelUsage);
            const entries = byModel
                ? Object.entries(byModel)
                : [['unknown', usage] as [string, unknown]];
            for (const [model, value] of entries) {
                const modelUsage = record(value);
                if (!modelUsage) continue;
                const cacheRead = number(modelUsage.cachedReadTokens);
                const cacheWrite = number(modelUsage.cacheCreationTokens);
                accumulator.addUsage(at, model.slice(0, 200), {
                    input: Math.max(0, number(modelUsage.inputTokens) - cacheRead - cacheWrite),
                    output: number(modelUsage.outputTokens),
                    cacheRead,
                    cacheWrite,
                    cacheWrite1h: 0,
                    reasoning: number(modelUsage.reasoningTokens),
                });
            }
        },
        finish() {
            accumulator.endStream();
        },
    };
}

/**
 * Exhaustive on purpose: a newly catalogued provider fails to compile until it declares how its transcript records
 * usage, instead of silently streaming its transcript through another provider's parser.
 */
const usageParsers: Record<
    AgentProvider,
    (accumulator: UsageAccumulator, options?: UsageParserOptions) => UsageLineParser
> = {
    claude: claudeUsageParser,
    codex: codexUsageParser,
    grok: grokUsageParser,
};

export function usageParserFor(
    provider: AgentProvider,
    accumulator: UsageAccumulator,
    options?: UsageParserOptions,
): UsageLineParser {
    return usageParsers[provider](accumulator, options);
}

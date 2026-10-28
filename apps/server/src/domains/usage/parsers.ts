import { createHash } from 'node:crypto';

import type { AgentProvider, UsageCredits } from '@caxri/protocol';

import type { TranscriptPullRequestScan } from '../agents';
import { createTranscriptPullRequestScan, scanTranscriptPullRequestLine } from '../agents';
import type { RateLimitObservation, UsageAccumulator, UsageTokens } from './accumulator';
import type { ServiceTier } from './record';

/**
 * Consumes one transcript file line by line. Every parser is streaming: usage reaches the accumulator as soon as its
 * line is read, so a snapshot taken between lines is exact and a live tail can keep feeding the same parser. `finish`
 * marks the end of the file so the next file's first record never extends this one's active time.
 */
export interface UsageLineParser {
    line(text: string): void;
    /**
     * Settles a decision a parser deferred until a later line, when the file has no more complete lines yet. Only a
     * forked Codex rollout defers one (whether its first event is replayed history).
     */
    flush?(): void;
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
     * rollout), so its first cumulative total includes usage that file already holds. It only sets the baseline when
     * the event lacks the request's own usage.
     */
    isContinuation?: boolean;
    /**
     * Claude messages already seen by this Agent Session's other files. A forked subagent's side file repeats the
     * parent message that spawned it, so main and side files of one scan share one map and merge by message ID.
     */
    claudeMessages?: Map<string, ClaudeMessageUsage>;
    /**
     * Whether an earlier transcript already counts the billed unit with this digest (see {@link usageKeyDigest}). Asked
     * only for main files: resume and fork copy history into a new main transcript.
     */
    isCountedElsewhere?: (digest: string) => boolean;
}

/**
 * One-way digest of a billed unit's provider identity: 66 bits, so a machine's whole history never collides in
 * practice, and the stored aggregate keeps no message ID.
 */
export function usageKeyDigest(provider: AgentProvider, key: string): string {
    return createHash('sha256').update(`${provider}:${key}`).digest('base64url').slice(0, 11);
}

/**
 * Records a main-file unit's digest and answers whether this file should count it.
 */
function shouldCountUnit(
    accumulator: UsageAccumulator,
    options: UsageParserOptions,
    provider: AgentProvider,
    key: string,
): boolean {
    if (options.isSideStream) return true;
    const digest = usageKeyDigest(provider, key);
    accumulator.addKey(digest);
    return !options.isCountedElsewhere?.(digest);
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

export interface ClaudeMessageUsage {
    at: number;
    model: string;
    usage: UsageTokens;
    /**
     * An earlier transcript counts this message, so neither it nor its growth is added here.
     */
    isCountedElsewhere: boolean;
}

/**
 * Claude Code writes one record per streamed content block, each repeating the message's `usage` as it grows. Records
 * are therefore merged per message ID with a per-field maximum, the same rule `collectClaudeUsage` uses for delegation
 * results; summing them would multiply-count every multi-block reply. A repeat adds only its growth over the maximum
 * seen so far, attributed to the message's first record. `claude --resume <id> --fork-session` copies every earlier
 * record, IDs and timestamps unchanged, into the new transcript; {@link UsageParserOptions.isCountedElsewhere} keeps
 * those counted once.
 */
export function claudeUsageParser(
    accumulator: UsageAccumulator,
    options: UsageParserOptions = {},
): UsageLineParser {
    const messages = options.claudeMessages ?? new Map<string, ClaudeMessageUsage>();
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
            const messageId = string(message.id);
            const requestId = string(entry.requestId);
            const id = messageId ?? requestId ?? `anonymous-${(anonymous += 1)}`;
            const previous = messages.get(id);
            if (!previous) {
                const isCounted =
                    messageId === undefined ||
                    shouldCountUnit(
                        accumulator,
                        options,
                        'claude',
                        `${messageId}:${requestId ?? ''}`,
                    );
                messages.set(id, { at, model, usage: next, isCountedElsewhere: !isCounted });
                if (isCounted)
                    accumulator.addUsage(at, model, next, {
                        contextTokens: next.input + next.cacheRead + next.cacheWrite,
                    });
                return;
            }
            const growth = { ...next };
            for (const key of Object.keys(next) as Array<keyof UsageTokens>) {
                growth[key] = Math.max(0, next[key] - previous.usage[key]);
                previous.usage[key] = Math.max(previous.usage[key], next[key]);
            }
            if (!previous.isCountedElsewhere) {
                const { input, cacheRead, cacheWrite } = previous.usage;
                accumulator.addUsage(previous.at, previous.model, growth, {
                    contextTokens: input + cacheRead + cacheWrite,
                });
            }
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

/**
 * Codex names its account-wide limit `codex`; any other `limit_id` is a model-specific limit whose windows are not the
 * account's general 5-hour and weekly ones. A rollout without `limit_id` predates model-specific limits.
 */
const CODEX_GENERAL_LIMIT_ID = 'codex';

/**
 * Codex puts whichever windows a plan has in `primary` and `secondary` (a plan may have only a weekly one), and its own
 * status line names each by its length, so the general limit's windows are scoped the same way. Lengths are matched
 * with Codex's own tolerance for a server rounding the minutes.
 */
function codexWindowScope(windowMinutes: number): 'session' | 'weekly' | undefined {
    const isAbout = (target: number) => Math.abs(windowMinutes - target) <= target * 0.05;
    if (isAbout(300)) return 'session';
    if (isAbout(10_080)) return 'weekly';
    return undefined;
}

/**
 * Codex's `credits` snapshot (`has_credits` in a rollout, `hasCredits` from the app-server; `balance` is a decimal
 * string). Undefined for an account without credits, so only usable credits ever reach the weekly usage guard.
 */
export function codexCredits(value: {
    hasCredits: unknown;
    unlimited: unknown;
    balance: unknown;
}): UsageCredits | undefined {
    if (value.hasCredits !== true && value.unlimited !== true) return undefined;
    if (value.unlimited === true) return { unlimited: true };
    const balance = typeof value.balance === 'string' ? Number(value.balance) : NaN;
    return { unlimited: false, ...(Number.isFinite(balance) && balance >= 0 && { balance }) };
}

function codexRateLimits(value: unknown, at: number): RateLimitObservation | undefined {
    const limits = record(value);
    if (!limits) return;
    const limitId = string(limits.limit_id);
    const isGeneral = !limitId || limitId === CODEX_GENERAL_LIMIT_ID;
    const windows = [limits.primary, limits.secondary].flatMap((candidate) => {
        const window = record(candidate);
        if (!window || typeof window.used_percent !== 'number') return [];
        const resetsAt = number(window.resets_at);
        const windowMinutes = Math.round(number(window.window_minutes));
        const scope = isGeneral ? codexWindowScope(windowMinutes) : undefined;
        return [
            {
                windowMinutes,
                usedPercent: Math.min(100, Math.max(0, window.used_percent)),
                ...(resetsAt > 0 && { resetsAt: Math.round(resetsAt * 1000) }),
                ...(scope && { scope }),
            },
        ];
    });
    if (windows.length === 0) return;
    const credits = record(limits.credits);
    const usable =
        credits &&
        codexCredits({
            hasCredits: credits.has_credits,
            unlimited: credits.unlimited,
            balance: credits.balance,
        });
    return {
        observedAt: at,
        planType: string(limits.plan_type),
        windows,
        ...(usable && { credits: usable }),
    };
}

const CODEX_USAGE_LINE_KINDS = [
    'token_count',
    'turn_context',
    'thread_settings_applied',
    'session_meta',
] as const;

/**
 * Longest pause inside the burst of parent usage that Codex replayed at the head of a forked rollout. Codex releases
 * from June to August 2026 copied the parent's `token_count` events into a subagent's fork, rewritten to one instant:
 * ccusage measured those bursts at 10 to 40ms, and the fork's own first request at 5.8s or more after them.
 */
const CODEX_REPLAY_BURST_GAP_MS = 1000;

/**
 * Codex records the processing tier on `thread_settings_applied`. `fast` is Codex's name for OpenAI's priority
 * processing; `default` and `standard` both mean the standard tier.
 */
function codexServiceTier(value: string): ServiceTier | undefined {
    if (value === 'priority' || value === 'fast') return 'priority';
    if (value === 'flex') return 'flex';
    return undefined;
}

interface CodexTokenCount {
    at: number;
    totals: CodexTotals;
    /**
     * `last_token_usage`: the latest request's own usage.
     */
    last?: CodexTotals;
    model: string;
    serviceTier?: ServiceTier;
}

function isSameCodexTotals(left: CodexTotals, right: CodexTotals): boolean {
    return (
        left.input === right.input &&
        left.cached === right.cached &&
        left.cacheWrite === right.cacheWrite &&
        left.output === right.output &&
        left.reasoning === right.reasoning
    );
}

/**
 * Codex `token_count` events carry the latest request's own `last_token_usage` and the thread's running
 * `total_token_usage`, and repeat both whenever rate limits refresh. An event whose total advanced counts its request's
 * own usage, ccusage's rule: a forked or reverted thread's running total starts from the history it continues, so a
 * delta from zero would count that history again. Without a per-request figure, usage is the delta between totals, a
 * shrinking total only resets the baseline, and a continuation file's first total only sets it. Codex counts cached
 * input inside `input_tokens` and reasoning inside `output_tokens`. `last_token_usage.input_tokens` is the latest
 * request's whole context, which selects a long-context price tier.
 *
 * A rollout whose `session_meta` names `forked_from_id` may open with a replay of its parent's totals (see
 * {@link CODEX_REPLAY_BURST_GAP_MS}). An event stamped with the fork's own creation instant is replay at once, even when
 * the parent made a single request. Otherwise the first event is held until the second arrives: two events within the
 * burst gap start a replay, whose last total becomes the baseline; else the held event is the fork's own first request.
 * A continuation file's first event (see {@link UsageParserOptions.isContinuation}) is a new request, not a repeat: in
 * real reverted threads its running total exceeds the original file's last total by exactly its `last_token_usage`, so
 * it counts through `last` like any other advanced event.
 */
export function codexUsageParser(
    accumulator: UsageAccumulator,
    options: UsageParserOptions = {},
): UsageLineParser {
    const trackPullRequests = pullRequestTracker(accumulator);
    let model = 'unknown';
    let serviceTier: ServiceTier | undefined;
    let previous: CodexTotals | undefined;
    let replay: 'none' | 'undecided' | 'skipping' = 'none';
    let held: CodexTokenCount | undefined;
    let lastReplayAt = 0;
    /**
     * Record time of the `session_meta` that names `forked_from_id`: Codex stamps the parent history it copies into a
     * fork with the fork's creation instant, so a `token_count` at that instant is replayed whatever else the file
     * holds.
     */
    let forkedAt: number | undefined;
    const count = (event: CodexTokenCount) => {
        const { totals, last } = event;
        const base = previous;
        previous = totals;
        const hasAdvanced = !base || !isSameCodexTotals(base, totals);
        let delta: (key: keyof CodexTotals) => number;
        if (hasAdvanced && last) delta = (key) => last[key];
        else {
            if (!base && options.isContinuation) return;
            if (base && (totals.input < base.input || totals.output < base.output)) return;
            delta = (key) => totals[key] - (base?.[key] ?? 0);
        }
        const cached = Math.max(0, delta('cached'));
        accumulator.addUsage(
            event.at,
            event.model,
            {
                input: Math.max(0, delta('input') - cached),
                output: Math.max(0, delta('output')),
                cacheRead: cached,
                cacheWrite: Math.max(0, delta('cacheWrite')),
                cacheWrite1h: 0,
                reasoning: Math.max(0, delta('reasoning')),
            },
            {
                contextTokens: last && last.input > 0 ? last.input : Math.max(0, delta('input')),
                serviceTier: event.serviceTier,
            },
        );
    };
    const release = () => {
        if (!held) return;
        const event = held;
        held = undefined;
        count(event);
    };
    return {
        line(text) {
            const at = isoTimestamp(text);
            if (at !== undefined) accumulator.markActivity(at);
            trackPullRequests(text);
            if (at === undefined) return;
            if (CODEX_USAGE_LINE_KINDS.every((kind) => !text.includes(`"${kind}"`))) return;
            const entry = record(parseJson(text));
            const payload = record(entry?.payload);
            if (!payload) return;
            if (entry?.type === 'session_meta') {
                if (replay === 'none' && !previous && string(payload.forked_from_id)) {
                    replay = 'undecided';
                    forkedAt = at;
                }
                return;
            }
            if (entry?.type === 'turn_context') {
                model = string(payload.model) ?? model;
                return;
            }
            if (entry?.type !== 'event_msg') return;
            if (payload.type === 'thread_settings_applied') {
                const recorded = string(record(payload.thread_settings)?.service_tier);
                if (recorded !== undefined) serviceTier = codexServiceTier(recorded);
                return;
            }
            if (payload.type !== 'token_count') return;
            const limits = codexRateLimits(payload.rate_limits, at);
            if (limits) accumulator.observeRateLimits(limits);
            const info = record(payload.info);
            const totals = codexTotals(info?.total_token_usage);
            if (!totals) return;
            const event: CodexTokenCount = {
                at,
                totals,
                last: codexTotals(info?.last_token_usage),
                model,
                serviceTier,
            };
            if (replay === 'undecided') {
                if (!held && forkedAt !== undefined && at - forkedAt <= CODEX_REPLAY_BURST_GAP_MS) {
                    // Stamped with the fork's creation instant: parent history, even when it is a single event
                    // that the burst rule below could not tell from the fork's own first request.
                    previous = totals;
                    lastReplayAt = at;
                    replay = 'skipping';
                    return;
                }
                if (!held) {
                    held = event;
                    return;
                }
                // A rate-limit refresh repeats the running total; a replay's totals always advance.
                if (isSameCodexTotals(totals, held.totals)) return;
                if (at - held.at <= CODEX_REPLAY_BURST_GAP_MS) {
                    lastReplayAt = held.at;
                    held = undefined;
                    replay = 'skipping';
                } else {
                    replay = 'none';
                    release();
                }
            }
            if (replay === 'skipping') {
                if (at - lastReplayAt <= CODEX_REPLAY_BURST_GAP_MS) {
                    previous = totals;
                    lastReplayAt = at;
                    return;
                }
                replay = 'none';
            }
            count(event);
        },
        flush() {
            if (replay !== 'undecided') return;
            replay = 'none';
            release();
        },
        finish() {
            accumulator.endStream();
        },
    };
}

/**
 * Grok reports exact per-prompt usage on `turn_completed`, broken down by model, with its own cost in `costUsdTicks`
 * (10^10 ticks per USD, as Grok Build's user guide states for `grok usage`), which is preferred over a list-price
 * estimate and stored as is, since the usage record's native cost uses the same unit. Its `inputTokens` includes cache
 * reads and writes, summed over the turn's `modelCalls`, so their average is the context size that selects a price tier
 * when no native cost is present. Resume and fork copy earlier turns into the new session's file, so a prompt ID is
 * counted once across files.
 */
export function grokUsageParser(
    accumulator: UsageAccumulator,
    options: UsageParserOptions = {},
): UsageLineParser {
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
                if (!shouldCountUnit(accumulator, options, 'grok', promptId)) return;
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
                const inputTokens = number(modelUsage.inputTokens);
                const ticks = modelUsage.costUsdTicks;
                accumulator.addUsage(
                    at,
                    model.slice(0, 200),
                    {
                        input: Math.max(0, inputTokens - cacheRead - cacheWrite),
                        output: number(modelUsage.outputTokens),
                        cacheRead,
                        cacheWrite,
                        cacheWrite1h: 0,
                        reasoning: number(modelUsage.reasoningTokens),
                    },
                    {
                        contextTokens: inputTokens / Math.max(1, number(modelUsage.modelCalls)),
                        ...(typeof ticks === 'number' &&
                            Number.isFinite(ticks) &&
                            ticks >= 0 && { nativeCostTicks: ticks }),
                    },
                );
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

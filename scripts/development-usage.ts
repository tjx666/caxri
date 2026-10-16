import { z } from 'zod';

import pricesJson from './development-usage-prices.json';

export type Provider = 'codex' | 'claude' | 'grok';
export type JsonRecord = Record<string, unknown>;

/**
 * Input includes cache reads/writes; reasoning is already part of output.
 */
export interface TokenUsage {
    input: number;
    output: number;
    cached: number;
    write: number;
    write1h: number;
    reasoning: number;
    nativeCostTicks?: number;
}

export interface UsageRequest {
    provider: Provider;
    model: string;
    at: string;
    usage: TokenUsage;
}

type Rates = [number | null, number | null, number | null, number | null, number | null];
interface ModelPrice {
    short: Rates;
    long?: Rates;
    threshold?: number | null;
}
interface PriceSnapshot {
    checkedAt: string;
    sources: string[];
    rates: Record<'codex' | 'claude', Partial<Record<string, ModelPrice>>>;
}

const rate = z.number().nonnegative().nullable();
const rates = z.tuple([rate, rate, rate, rate, rate]);
const modelPrice = z.object({
    short: rates,
    long: rates.optional(),
    threshold: z.number().positive().nullable().optional(),
});
const modelRates = z.record(z.string(), modelPrice);
const priceSnapshot = z.object({
    checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sources: z.array(z.url()),
    rates: z.object({
        codex: modelRates,
        claude: modelRates,
    }),
});

const DEVELOPMENT_PRICES: PriceSnapshot = priceSnapshot.parse(pricesJson);
const PROVIDERS: Provider[] = ['codex', 'claude', 'grok'];
const NAMES = { codex: 'Codex', claude: 'Claude Code', grok: 'Grok Build' };
const TOKEN_FIELDS = ['input', 'output', 'cached', 'write', 'write1h', 'reasoning'] as const;
const START = '<!-- development-usage:start -->';
const END = '<!-- development-usage:end -->';

export function record(value: unknown): JsonRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as JsonRecord)
        : {};
}

function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function timestamp(value: unknown): string | undefined {
    const milliseconds =
        typeof value === 'number' ? value * (value < 1e11 ? 1000 : 1) : Date.parse(String(value));
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

export function isProjectCwd(value: unknown): boolean {
    return (
        typeof value === 'string' &&
        value.split(/[\\/]/).some((part) => /^caxri(?:$|-)/i.test(part))
    );
}

export function tokenUsage(value: unknown, provider: Provider): TokenUsage {
    const raw = record(value);
    const creation = record(raw.cache_creation);
    const cached = count(
        raw.cached_input_tokens ?? raw.cache_read_input_tokens ?? raw.cachedReadTokens,
    );
    const write1h = count(creation.ephemeral_1h_input_tokens);
    const write = Math.max(
        count(
            raw.cache_write_input_tokens ??
                raw.cache_creation_input_tokens ??
                raw.cacheCreationTokens,
        ),
        count(creation.ephemeral_5m_input_tokens) + write1h,
    );
    return {
        input:
            count(raw.input_tokens ?? raw.inputTokens) +
            (provider === 'claude' ? cached + write : 0),
        output: count(raw.output_tokens ?? raw.outputTokens),
        cached,
        write,
        write1h,
        reasoning: count(raw.reasoning_output_tokens ?? raw.reasoningTokens),
        ...(typeof raw.costUsdTicks === 'number' &&
            Number.isFinite(raw.costUsdTicks) &&
            raw.costUsdTicks >= 0 && { nativeCostTicks: raw.costUsdTicks }),
    };
}

function signature(usage: TokenUsage): string {
    return TOKEN_FIELDS.map((key) => usage[key]).join(',');
}

export function requestCost(request: UsageRequest): number | undefined {
    const { provider, model, usage } = request;
    if (provider === 'grok')
        return usage.nativeCostTicks === undefined ? undefined : usage.nativeCostTicks / 1e10;
    const price = DEVELOPMENT_PRICES.rates[provider][model];
    if (!price) return;
    const rates = price.threshold && usage.input > price.threshold ? price.long : price.short;
    if (!rates) return;
    const quantities = [
        Math.max(0, usage.input - usage.cached - usage.write),
        usage.cached,
        Math.max(0, usage.write - usage.write1h),
        usage.write1h,
        usage.output,
    ];
    if (quantities.some((quantity, index) => quantity > 0 && rates[index] === null)) return;
    return (
        quantities.reduce((sum, quantity, index) => sum + quantity * (rates[index] ?? 0), 0) / 1e6
    );
}

interface CodexUnit {
    request: UsageRequest;
    isInProject: boolean;
    line: number;
    responseId?: string;
    aliases: string[];
}

/**
 * Preserve the cwd at each request, then reconcile response records with legacy events. Compaction can bill without an
 * incremental event; tool waits can separate matching records in time.
 */
export class CodexLedger {
    private model = 'unknown';
    private line = 0;
    private epoch = 0;
    private previousTotal = 0;
    private readonly cumulative = new Set<string>();
    private readonly events: CodexUnit[] = [];
    private readonly mirrors: CodexUnit[] = [];

    constructor(private isInProject = true) {}

    consume(entry: JsonRecord, lineNumber = this.line + 1): void {
        this.line = lineNumber;
        const payload = record(entry.payload);
        if (entry.type === 'turn_context') {
            if (typeof payload.model === 'string') this.model = payload.model;
            if (typeof payload.cwd === 'string') this.isInProject = isProjectCwd(payload.cwd);
            return;
        }
        const at = timestamp(entry.timestamp);
        if (!at) return;
        if (entry.type === 'token_usage_record') {
            const usage = tokenUsage(payload.usage, 'codex');
            if (!usage.input && !usage.output) return;
            this.mirrors.push({
                request: { provider: 'codex', model: this.model, at, usage },
                isInProject: this.isInProject,
                line: this.line,
                responseId:
                    typeof payload.response_id === 'string' ? payload.response_id : undefined,
                aliases: [],
            });
        }
        if (entry.type !== 'event_msg' || payload.type !== 'token_count') return;
        const info = record(payload.info);
        const total = record(info.total_token_usage);
        if (Object.keys(total).length > 0) {
            const totalTokens = count(total.total_tokens);
            if (totalTokens < this.previousTotal) this.epoch += 1;
            this.previousTotal = totalTokens;
            const key = `${this.epoch}|${signature(tokenUsage(total, 'codex'))}|${totalTokens}`;
            if (this.cumulative.has(key)) return;
            this.cumulative.add(key);
        }
        const usage = tokenUsage(info.last_token_usage, 'codex');
        if (!usage.input && !usage.output) return;
        this.events.push({
            request: { provider: 'codex', model: this.model, at, usage },
            isInProject: this.isInProject,
            line: this.line,
            aliases: [`event|${at}|${signature(usage)}`],
        });
    }

    finish(): CodexUnit[] {
        const matched = new Set<CodexUnit>();
        const bySignature = new Map<string, CodexUnit[]>();
        const nextLine = new Map<CodexUnit, number>();
        for (const [index, mirror] of this.mirrors.entries()) {
            const key = signature(mirror.request.usage);
            const candidates = bySignature.get(key) ?? [];
            candidates.push(mirror);
            bySignature.set(key, candidates);
            nextLine.set(mirror, this.mirrors[index + 1]?.line ?? Infinity);
        }
        const remaining = this.events.filter((event) => {
            const candidate = bySignature
                .get(signature(event.request.usage))
                ?.findLast(
                    (mirror) =>
                        !matched.has(mirror) &&
                        mirror.line < event.line &&
                        event.line - mirror.line <= 200 &&
                        event.line < (nextLine.get(mirror) ?? 0),
                );
            if (!candidate) return true;
            matched.add(candidate);
            candidate.aliases.push(...event.aliases);
            return false;
        });
        for (const mirror of this.mirrors) {
            mirror.aliases.push(
                mirror.responseId
                    ? `response|${mirror.responseId}`
                    : `event|${mirror.request.at}|${signature(mirror.request.usage)}`,
            );
        }
        return [...remaining, ...this.mirrors].filter((unit) => unit.isInProject);
    }
}

interface ProviderTotal {
    tokens: number;
    input: number;
    output: number;
    cached: number;
    requests: number;
    knownCostUsd: number;
    unpricedTokens: number;
}

export interface DevelopmentUsageSummary {
    asOf: string;
    pricesCheckedAt: string;
    providers: Record<Provider, ProviderTotal>;
    coverage: Partial<Record<string, number>>;
}

/**
 * All request identities stay in memory; the published result contains only counts and costs.
 */
export class DevelopmentUsage {
    private readonly requests = new Set<UsageRequest>();
    private readonly aliases = new Map<string, UsageRequest>();

    readonly coverage: Partial<Record<string, number>> = {};

    constructor(readonly asOf: string) {}

    mark(key: string, amount = 1): void {
        this.coverage[key] = (this.coverage[key] ?? 0) + amount;
    }

    add(request: UsageRequest, aliases: string[]): boolean {
        if (request.at > this.asOf) return false;
        const keys = aliases.map((key) => `${request.provider}|${key}`);
        const existing = keys
            .map((key) => this.aliases.get(key))
            .find((item) => item !== undefined);
        if (existing) {
            if (request.provider === 'claude') {
                for (const key of TOKEN_FIELDS)
                    existing.usage[key] = Math.max(existing.usage[key], request.usage[key]);
            }
            for (const key of keys) this.aliases.set(key, existing);
            this.mark(`${request.provider}DuplicateRecords`);
            return false;
        }
        for (const key of keys) this.aliases.set(key, request);
        this.requests.add(request);
        return true;
    }

    claude(entry: JsonRecord): void {
        const message = record(entry.message);
        const at = timestamp(entry.timestamp);
        if (!at || !message.usage || entry.type !== 'assistant' || !isProjectCwd(entry.cwd)) return;
        const model = typeof message.model === 'string' ? message.model : 'unknown';
        if (model === '<synthetic>') return;
        const usage = tokenUsage(message.usage, 'claude');
        if (!usage.input && !usage.output) return;
        const identity =
            typeof message.id === 'string'
                ? message.id
                : typeof entry.requestId === 'string'
                  ? entry.requestId
                  : `${at}|${model}|${signature(usage)}`;
        this.add({ provider: 'claude', model, at, usage }, [identity]);
    }

    grok(entry: JsonRecord, fallbackModel: string): boolean {
        const update = record(record(entry.params).update);
        const raw = record(update.usage);
        const at = timestamp(entry.timestamp);
        if (!at || !update.usage || update.sessionUpdate !== 'turn_completed' || at > this.asOf)
            return false;
        const modelUsage = record(raw.modelUsage);
        const models: Array<[string, unknown]> =
            Object.keys(modelUsage).length > 0
                ? Object.entries(modelUsage)
                : [[fallbackModel, raw]];
        const id = update.prompt_id ?? update.turnId ?? update.id;
        const identity =
            typeof id === 'string' ? id : `${at}|${signature(tokenUsage(raw, 'grok'))}`;
        let isMeasured = false;
        for (const [model, value] of models) {
            const usage = tokenUsage(value, 'grok');
            if (!usage.input && !usage.output && usage.nativeCostTicks === undefined) continue;
            isMeasured = true;
            this.add({ provider: 'grok', model, at, usage }, [`${identity}|${model}`]);
        }
        return isMeasured;
    }

    summary(): DevelopmentUsageSummary {
        const providers = Object.fromEntries(
            PROVIDERS.map((provider) => [
                provider,
                {
                    tokens: 0,
                    input: 0,
                    output: 0,
                    cached: 0,
                    requests: 0,
                    knownCostUsd: 0,
                    unpricedTokens: 0,
                },
            ]),
        ) as Record<Provider, ProviderTotal>;
        for (const request of this.requests) {
            const total = providers[request.provider];
            const usage = request.usage;
            total.input += usage.input;
            total.output += usage.output;
            total.cached += usage.cached;
            total.tokens += usage.input + usage.output;
            total.requests += 1;
            const cost = requestCost(request);
            if (cost === undefined) total.unpricedTokens += usage.input + usage.output;
            else total.knownCostUsd += cost;
        }
        for (const total of Object.values(providers))
            total.knownCostUsd = Number(total.knownCostUsd.toFixed(6));
        return {
            asOf: this.asOf,
            pricesCheckedAt: DEVELOPMENT_PRICES.checkedAt,
            providers,
            coverage: { ...this.coverage },
        };
    }
}

export function renderDevelopmentUsage(summary: DevelopmentUsageSummary): string {
    const format = (value: number): string => value.toLocaleString('en-US');
    const money = (value: number): string =>
        `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const totals = Object.values(summary.providers);
    const tokens = totals.reduce((sum, total) => sum + total.tokens, 0);
    const cost = totals.reduce((sum, total) => sum + total.knownCostUsd, 0);
    const unpriced = totals.reduce((sum, total) => sum + total.unpricedTokens, 0);
    return [
        START,
        '',
        '## Development usage',
        '',
        `Personal Caxri development usage from retained local logs, as of **${summary.asOf.replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC')}**.`,
        'Includes Codex, Claude Code, Grok Build, child agents, identifiable Caxri worktrees and auxiliary directories, and deduplicated Claude session backups.',
        '',
        '| Tool | Tokens (input + output) | Known USD cost |',
        '| --- | ---: | ---: |',
        ...PROVIDERS.map(
            (provider) =>
                `| ${NAMES[provider]} | ${format(summary.providers[provider].tokens)} | ${money(summary.providers[provider].knownCostUsd)} |`,
        ),
        `| **Total** | **${format(tokens)}** | **${money(cost)}** |`,
        '',
        `Codex and Claude costs are **standard API list-price equivalents**, using the price snapshot checked on ${summary.pricesCheckedAt}. Grok uses its recorded USD cost. These are not subscription payments or historical invoices.`,
        'Token totals include cache reads and writes once; reasoning is already included in output. Long-context rates apply per request; unspecified Claude cache-write TTLs use the 5-minute rate.',
        `Unpriced usage: **${format(unpriced)} tokens**. Grok sessions without usable usage: **${format(summary.coverage.grokSessionsWithoutUsage ?? 0)}**. Deleted logs, other machines, hosted agents and unattributable work are outside this snapshot.`,
        '',
        'Update with `bun run usage:development --write`; omit `--write` to preview, use `--json` for aggregate JSON, or `--as-of <ISO timestamp>` for a fixed cutoff. The active Codex accounting session and its identifiable descendants are excluded when `CODEX_THREAD_ID` is available.',
        'The script reads session files without changing them. Default backup paths use `~`; additional Claude project directories can be supplied with `--claude-backup <path>`. Prices are pinned in [the price snapshot](scripts/development-usage-prices.json); review that snapshot when model prices change.',
        '',
        'Pricing sources: [OpenAI](https://developers.openai.com/api/docs/pricing), [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing).',
        '',
        END,
    ].join('\n');
}

export function updateDevelopmentUsageReadme(
    readme: string,
    summary: DevelopmentUsageSummary,
    block = renderDevelopmentUsage(summary),
): string {
    const start = readme.indexOf(START);
    const end = readme.indexOf(END);
    if (start === -1 && end === -1) return `${readme.trimEnd()}\n\n${block}\n`;
    if (
        start === -1 ||
        end < start ||
        readme.includes(START, start + START.length) ||
        readme.includes(END, end + END.length)
    ) {
        throw new Error('README development usage markers must appear exactly once, in order.');
    }
    return `${readme.slice(0, start)}${block}${readme.slice(end + END.length)}`;
}

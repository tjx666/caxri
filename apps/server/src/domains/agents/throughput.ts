import type {
    AgentProvider,
    AgentThroughput,
    AgentThroughputAggregate,
    AgentThroughputSample,
    AgentThroughputVariant,
} from '@caxri/protocol';
import { AGENT_THROUGHPUT_RECENT_RESPONSES, AGENT_THROUGHPUT_SAMPLE_LIMIT } from '@caxri/protocol';
import { omit } from 'es-toolkit';

/**
 * Model and tier pairs reported per transcript. A conversation rarely uses more than a few; the cap only bounds a
 * pathological transcript.
 */
const MAX_VARIANTS = 32;

/**
 * One measured model response reported by a provider's line scanner. `key` identifies the response: a scanner reports
 * the same response again (with the same key) when a later transcript line extends it, and the newer measurement
 * replaces the older one instead of counting twice.
 */
export interface ThroughputResponse extends AgentThroughputSample {
    key: string;
}

export interface ThroughputSink {
    response(response: ThroughputResponse): void;
    turnStarted(): void;
    turnTimeToFirstToken(milliseconds: number): void;
}

/**
 * Provider-owned, stateful reader of one transcript's lines, fed in file order. It only reports numbers to the sink and
 * keeps no transcript content.
 */
export interface ThroughputLineScanner {
    scanLine(line: string, sink: ThroughputSink): void;
}

const EMPTY_AGGREGATE: AgentThroughputAggregate = {
    durationMs: 0,
    outputTokens: 0,
    responseCount: 0,
};

function add(
    aggregate: AgentThroughputAggregate,
    sample: AgentThroughputSample,
    sign: 1 | -1,
): AgentThroughputAggregate {
    return {
        durationMs: aggregate.durationMs + sign * sample.durationMs,
        outputTokens: aggregate.outputTokens + sign * sample.outputTokens,
        responseCount: aggregate.responseCount + sign,
    };
}

function variantKey(sample: AgentThroughputSample): string {
    return `${sample.model ?? ''}\0${sample.speed ?? ''}`;
}

/**
 * Folds scanner reports into the session, turn, and recent-window totals. Session and turn totals are running sums, so
 * a transcript of any length costs constant memory; only the last {@link AGENT_THROUGHPUT_SAMPLE_LIMIT} samples are
 * kept.
 */
export class ThroughputAccumulator implements ThroughputSink {
    private samples: ThroughputResponse[] = [];
    private session = EMPTY_AGGREGATE;
    private turn = EMPTY_AGGREGATE;
    private readonly variants = new Map<string, AgentThroughputVariant>();
    /**
     * Whether the newest sample belongs to the current turn, so replacing it adjusts the turn total too.
     */
    private isLatestInTurn = false;
    /**
     * Time to first token of the latest finished turn. Kept while the next turn runs, so it never describes a turn in
     * progress.
     */
    private timeToFirstTokenMs: number | undefined;

    private addVariant(sample: AgentThroughputSample, sign: 1 | -1): void {
        const key = variantKey(sample);
        const current = this.variants.get(key);
        if (!current && this.variants.size >= MAX_VARIANTS) return;
        const next: AgentThroughputVariant = {
            ...add(current ?? EMPTY_AGGREGATE, sample, sign),
            ...(sample.model !== undefined && { model: sample.model }),
            ...(sample.speed !== undefined && { speed: sample.speed }),
        };
        if (next.responseCount > 0) this.variants.set(key, next);
        else this.variants.delete(key);
    }

    response(response: ThroughputResponse): void {
        const latest = this.samples.at(-1);
        if (latest?.key === response.key) {
            this.session = add(this.session, latest, -1);
            if (this.isLatestInTurn) this.turn = add(this.turn, latest, -1);
            this.addVariant(latest, -1);
            this.samples.pop();
        }
        this.samples.push(response);
        if (this.samples.length > AGENT_THROUGHPUT_SAMPLE_LIMIT) this.samples.shift();
        this.session = add(this.session, response, 1);
        this.addVariant(response, 1);
        this.turn = add(this.turn, response, 1);
        this.isLatestInTurn = true;
    }

    turnStarted(): void {
        this.turn = EMPTY_AGGREGATE;
        this.isLatestInTurn = false;
    }

    turnTimeToFirstToken(milliseconds: number): void {
        this.timeToFirstTokenMs = milliseconds;
    }

    snapshot(provider: AgentProvider): AgentThroughput | null {
        if (this.samples.length === 0) return null;
        const recentSamples = this.samples.slice(-AGENT_THROUGHPUT_RECENT_RESPONSES);
        let recent = EMPTY_AGGREGATE;
        for (const sample of recentSamples) recent = add(recent, sample, 1);
        return {
            provider,
            recent,
            samples: this.samples.map((sample) => omit(sample, ['key'])),
            session: this.session,
            byModel: this.variants
                .values()
                .toArray()
                .toSorted((a, b) => b.responseCount - a.responseCount),
            turn: this.turn,
            ...(this.timeToFirstTokenMs !== undefined && {
                turnTimeToFirstTokenMs: this.timeToFirstTokenMs,
            }),
        };
    }
}

type RecordValue = Record<string, unknown>;

export function throughputRecord(value: unknown): RecordValue {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as RecordValue)
        : {};
}

export function parseThroughputLine(line: string): RecordValue | undefined {
    if (!line.startsWith('{')) return;
    try {
        return throughputRecord(JSON.parse(line));
    } catch {
        return;
    }
}

export function throughputTimestamp(value: unknown): number | undefined {
    if (typeof value !== 'string') return;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export function positiveTokens(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? value
        : undefined;
}

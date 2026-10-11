/**
 * Replays long Agent replies (a mixed reply and one that is a single long list) through the Agent Chat streaming
 * pipeline one delta at a time, once with the incremental parser and once with a full re-parse per delta, and reports
 * what each delta costs: the tail repair, the Markdown parse, and the per-block equality check a memoized renderer
 * runs.
 *
 * This is a trend tool, not a gate: wall-clock time moves with machine load. The CI gate is the parse-work and identity
 * accounting asserted in `src/__tests__/streaming-parser.test.ts`, which does not depend on machine speed.
 *
 * Usage: `bun run benchmark:markdown`.
 */
import {
    agentListReplyFixture,
    agentReplyFixture,
    streamingPrefixes,
} from '../src/__tests__/agent-reply.fixture.js';
import type { MarkdownBlock, StreamingMarkdownParser } from '../src/index.js';
import {
    createStreamingMarkdownParser,
    isSameMarkdownTree,
    parseMarkdownBlocks,
    repairStreamingMarkdown,
} from '../src/index.js';

const OPTIONS = { tables: true, fileLinks: true } as const;
const ROUNDS = 5;

function percentile(samples: readonly number[], fraction: number): number {
    const sorted = samples.toSorted((left, right) => left - right);
    return (
        sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ??
        0
    );
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * What a memoized block renderer does per delta: a reused block object passes on a reference check, any other block
 * needs the structural comparison, and a block that differs re-renders.
 */
function compareBlocks(previous: readonly MarkdownBlock[], next: readonly MarkdownBlock[]) {
    let compared = 0;
    let changed = 0;
    for (const [index, block] of next.entries()) {
        if (previous[index] === block) continue;
        compared += 1;
        if (!isSameMarkdownTree(previous[index], block)) changed += 1;
    }
    return { compared, changed };
}

/**
 * The pipeline before incremental parsing: every delta re-parses the whole reply.
 */
function createFullParser(): StreamingMarkdownParser {
    let parses = 0;
    let parsedCharacters = 0;
    return {
        parse(source) {
            parses += 1;
            parsedCharacters += source.length;
            return parseMarkdownBlocks(source, OPTIONS);
        },
        stats: () => ({ parses, parsedCharacters }),
    };
}

type Mode = 'full' | 'incremental';

function replay(mode: Mode, prefixes: readonly string[]) {
    const parser = mode === 'full' ? createFullParser() : createStreamingMarkdownParser(OPTIONS);
    const samples: number[] = [];
    let previous: readonly MarkdownBlock[] = [];
    let compared = 0;
    let rerendered = 0;
    for (const [index, prefix] of prefixes.entries()) {
        const isLast = index === prefixes.length - 1;
        const started = performance.now();
        const blocks = parser.parse(isLast ? prefix : repairStreamingMarkdown(prefix));
        const comparison = compareBlocks(previous, blocks);
        compared += comparison.compared;
        rerendered += comparison.changed;
        samples.push(performance.now() - started);
        previous = blocks;
    }
    return { compared, rerendered, samples, stats: parser.stats() };
}

function measure(mode: Mode, text: string, prefixes: readonly string[]) {
    replay(mode, prefixes);
    const totals: number[] = [];
    const all: number[] = [];
    let last = replay(mode, prefixes);
    for (let iteration = 0; iteration < ROUNDS; iteration += 1) {
        last = replay(mode, prefixes);
        totals.push(last.samples.reduce((sum, sample) => sum + sample, 0));
        all.push(...last.samples);
    }
    const late = last.samples.slice(-Math.ceil(last.samples.length / 10));
    return {
        mode,
        totalMs: { median: round(percentile(totals, 0.5)), max: round(Math.max(...totals)) },
        perDeltaMs: {
            p50: round(percentile(all, 0.5)),
            p95: round(percentile(all, 0.95)),
            max: round(Math.max(...all)),
        },
        /**
         * The final tenth of the reply, where a full re-parse is most expensive.
         */
        lateDeltaMs: { p50: round(percentile(late, 0.5)), p95: round(percentile(late, 0.95)) },
        parsedCharacters: last.stats.parsedCharacters,
        parseAmplification: round(last.stats.parsedCharacters / text.length),
        comparedBlocks: last.compared,
        rerenderedBlocks: last.rerendered,
    };
}

function scenario(text: string) {
    const prefixes = streamingPrefixes(text);
    return {
        characters: text.length,
        deltas: prefixes.length,
        incremental: measure('incremental', text, prefixes),
        full: measure('full', text, prefixes),
    };
}

const result = {
    rounds: ROUNDS,
    mixed: scenario(agentReplyFixture(12)),
    list: scenario(agentListReplyFixture(200)),
};
console.log(`CAXRI_MARKDOWN_BENCHMARK ${JSON.stringify(result, null, 2)}`);

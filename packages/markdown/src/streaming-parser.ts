import type {
    MarkdownBlock,
    MarkdownBlockOptions,
    TopLevelMarkdownEntry,
} from './markdown-blocks.js';
import { parseTopLevelMarkdown } from './markdown-blocks.js';

/**
 * Parse-work accounting, the machine-independent measure the streaming regressions assert on.
 */
export interface StreamingMarkdownStats {
    /**
     * Calls that actually ran the Markdown engine; an unchanged source is answered from the cache.
     */
    parses: number;
    /**
     * Characters handed to the Markdown engine across every parse. A full re-parse per delta makes this grow with the
     * square of the reply length; the incremental parser keeps it a small multiple of the length.
     */
    parsedCharacters: number;
}

export interface StreamingMarkdownParser {
    /**
     * Returns the same blocks `parseMarkdownBlocks(source, options)` would, reusing the block objects of every
     * top-level construct a previous call already settled. Any source is accepted; the cache only decides how much work
     * is skipped, never the result.
     */
    parse: (source: string) => MarkdownBlock[];
    stats: () => StreamingMarkdownStats;
}

interface SettledEntry extends TopLevelMarkdownEntry {
    /**
     * Source offset of the entry's first line.
     */
    offset: number;
    /**
     * Offset of the newline that ends the line after the entry's first line, or `-1` while either line is unfinished.
     * Reuse needs both: markdown-it decides whether a line opens a table, which can interrupt the paragraph above it,
     * by also reading the delimiter row below it.
     */
    settledEnd: number;
}

/**
 * Markdown-it applies the same rewrite before splitting lines; doing it first keeps the cached offsets aligned with
 * markdown-it's line map without changing any parse result.
 */
function normalize(source: string): string {
    return source.replaceAll(/\r\n?/gu, '\n').replaceAll('\0', '\u{FFFD}');
}

function commonPrefixLength(left: string, right: string): number {
    if (right.startsWith(left)) return left.length;
    const limit = Math.min(left.length, right.length);
    let index = 0;
    while (index < limit && left[index] === right[index]) index += 1;
    return index;
}

function lineOffsets(source: string): number[] {
    const offsets = [0];
    for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1))
        offsets.push(index + 1);
    return offsets;
}

function settledEnd(source: string, offset: number): number {
    const lineEnd = source.indexOf('\n', offset);
    return lineEnd === -1 ? -1 : source.indexOf('\n', lineEnd + 1);
}

/**
 * Parses a growing Agent reply without re-parsing the whole text on every delta.
 *
 * CommonMark reads lines in order, and a construct starting at the top level means every construct before it was closed
 * by that line. Closed constructs never reopen, so once a top-level construct's first line and the line after it are
 * complete and unchanged, everything before it is final: only the source from that line on needs parsing again.
 * Requiring complete lines matters: a partial `1` after a list is a paragraph that closes the list, while the finished
 * `1. item` continues it, and a `| a |` line opens a table only if the next line is a delimiter row. A link reference
 * definition is the one document-global construct, so a source markdown-it finds one in is always parsed whole.
 *
 * Reused blocks keep their object identity, so a memoized renderer skips them with a reference check instead of a
 * structural comparison. This is the block-level memoization Streamdown and LobeHub apply by splitting a message into
 * per-block source strings, but it keeps markdown-it as the only judge of where a block ends.
 */
export function createStreamingMarkdownParser(
    options: MarkdownBlockOptions = {},
): StreamingMarkdownParser {
    let source: string | undefined;
    let hasReferences = false;
    let entries: SettledEntry[] = [];
    let blocks: MarkdownBlock[] = [];
    const stats: StreamingMarkdownStats = { parses: 0, parsedCharacters: 0 };

    function reusableCount(next: string): number {
        if (source === undefined || hasReferences) return 0;
        const shared = commonPrefixLength(source, next);
        for (let index = entries.length - 1; index > 0; index -= 1) {
            const end = entries[index]!.settledEnd;
            if (end !== -1 && end < shared) return index;
        }
        return 0;
    }

    function parseFrom(next: string, kept: number) {
        const from = kept > 0 ? entries[kept]!.offset : 0;
        const firstLine = kept > 0 ? entries[kept]!.line : 0;
        const tail = next.slice(from);
        const parsed = parseTopLevelMarkdown(tail, options);
        stats.parses += 1;
        stats.parsedCharacters += tail.length;
        const offsets = lineOffsets(tail);
        const settled = parsed.entries.map((entry): SettledEntry => {
            const offset = from + (offsets[entry.line] ?? tail.length);
            return {
                ...entry,
                line: firstLine + entry.line,
                offset,
                settledEnd: settledEnd(next, offset),
            };
        });
        return { entries: settled, hasReferences: parsed.hasReferences };
    }

    return {
        parse(raw) {
            const next = normalize(raw);
            if (next === source) return blocks;
            let kept = reusableCount(next);
            let parsed = parseFrom(next, kept);
            /**
             * A definition that first appears in the tail can change a reused block above it.
             */
            if (parsed.hasReferences && kept > 0) {
                kept = 0;
                parsed = parseFrom(next, kept);
            }
            entries = [...entries.slice(0, kept), ...parsed.entries];
            hasReferences = parsed.hasReferences;
            blocks = entries.flatMap((entry) => (entry.block ? [entry.block] : []));
            source = next;
            return blocks;
        },
        stats: () => ({ ...stats }),
    };
}

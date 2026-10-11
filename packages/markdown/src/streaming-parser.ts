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
     * Source offset of the entry's first line, and of the newline that ends it (`-1` while that line is unfinished).
     */
    offset: number;
    lineEnd: number;
}

/**
 * A link reference definition (`[label]: url`) is document-global: one written later changes how an earlier `[label]`
 * parses, so a source that may contain one is always parsed whole.
 */
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]\n]+\]:/mu;

/**
 * Markdown-it rewrites these before splitting lines, which would shift the offsets the cache keeps.
 */
const NORMALIZED_CHARACTERS = /[\r\0]/u;

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

/**
 * Parses a growing Agent reply without re-parsing the whole text on every delta.
 *
 * CommonMark reads lines in order, and a construct starting at the top level means every construct before it was closed
 * by that line. Closed constructs never reopen, so once a top-level construct's whole first line is known and
 * unchanged, everything before it is final: only the source from that line on needs parsing again. Requiring the
 * complete first line matters: a partial `1` after a list is a paragraph that closes the list, while the finished `1.
 * item` continues it. Link reference definitions are the one global construct and disable reuse.
 *
 * Reused blocks keep their object identity, so a memoized renderer skips them with a reference check instead of a
 * structural comparison. This is the block-level memoization Streamdown and LobeHub apply by splitting a message into
 * per-block source strings, but it keeps markdown-it as the only judge of where a block ends.
 */
export function createStreamingMarkdownParser(
    options: MarkdownBlockOptions = {},
): StreamingMarkdownParser {
    let source: string | undefined;
    let entries: SettledEntry[] = [];
    let blocks: MarkdownBlock[] = [];
    const stats: StreamingMarkdownStats = { parses: 0, parsedCharacters: 0 };

    function reusableCount(next: string): number {
        if (
            source === undefined ||
            NORMALIZED_CHARACTERS.test(next) ||
            REFERENCE_DEFINITION.test(next)
        )
            return 0;
        const shared = commonPrefixLength(source, next);
        for (let index = entries.length - 1; index > 0; index -= 1) {
            const { lineEnd } = entries[index]!;
            if (lineEnd !== -1 && lineEnd < shared) return index;
        }
        return 0;
    }

    return {
        parse(next) {
            if (next === source) return blocks;
            const kept = reusableCount(next);
            const from = kept > 0 ? entries[kept]!.offset : 0;
            const firstLine = kept > 0 ? entries[kept]!.line : 0;
            const tail = next.slice(from);
            const offsets = lineOffsets(tail);
            const parsed = parseTopLevelMarkdown(tail, options).map((entry): SettledEntry => {
                const offset = from + (offsets[entry.line] ?? tail.length);
                return {
                    ...entry,
                    line: firstLine + entry.line,
                    offset,
                    lineEnd: next.indexOf('\n', offset),
                };
            });
            stats.parses += 1;
            stats.parsedCharacters += tail.length;
            entries = [...entries.slice(0, kept), ...parsed];
            blocks = entries.flatMap((entry) => (entry.block ? [entry.block] : []));
            source = next;
            return blocks;
        },
        stats: () => ({ ...stats }),
    };
}
